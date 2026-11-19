import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Readable, Writable } from 'node:stream';
import { dataDir, findProfile, loadConfig, mcpServerSchema } from '../config.js';
import { SqliteEventStore, type EventStore } from '../storage/event-store.js';
import { AgentRunner } from '../core/agent.js';
import type { Session, SessionEvent, ToolCall } from '../core/types.js';
import { ProcessExecutor, type ToolExecutor } from '../executor/client.js';
import { AiSdkGateway, type ModelGateway } from '../providers/gateway.js';
import { RuntimeServices } from './services.js';
import { createSubagentRunner } from './subagent.js';
import type { ToolMode } from '../core/tools.js';
import { needsUnknownReview } from '../core/unknown-review.js';
import { turnState } from '../core/turn-state.js';

const sessionParams = z.object({ sessionId: z.string().min(1) });
const newParams = z.object({
  cwd: z.string().refine(path.isAbsolute),
  mcpServers: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        command: z.string().refine(path.isAbsolute),
        args: z.array(z.string()),
        env: z
          .array(
            z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string() }),
          )
          .default([]),
        type: z.literal('stdio').optional(),
      }),
    )
    .max(30),
});
const promptParams = sessionParams.extend({
  prompt: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({ type: z.literal('resource_link'), uri: z.string(), name: z.string() }),
      ]),
    )
    .min(1),
});
type Entry = {
  session: Session;
  services: RuntimeServices;
  runner: AgentRunner;
  controller?: AbortController;
  run?: Promise<void>;
};
type Permission = { sessionId: string; resolve(approved: boolean): void };

/** ACP v1 adapter. Runtime, workspace boundaries, audit and approvals remain Bruin's. */
export class AcpServer {
  private initialized = false;
  private entries = new Map<string, Entry>();
  private permissions = new Map<string, Permission>();
  private nextId = 0;
  private closing = false;
  constructor(
    private store: EventStore,
    private executor: ToolExecutor,
    private send: (message: unknown) => void,
    private modelAlias?: string,
    private gateway: (readOnly: boolean, mode?: ToolMode) => ModelGateway = (readOnly, mode) =>
      new AiSdkGateway(mode ?? (readOnly ? 'read-only' : 'full')),
  ) {}
  private update(sessionId: string, update: Record<string, unknown>) {
    this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }
  private toolEvent(event: SessionEvent) {
    const statuses: Record<string, string> = {
      tool_requested: 'pending',
      tool_started: 'in_progress',
      tool_finished: event.payload.isError ? 'failed' : 'completed',
      tool_denied: 'failed',
      tool_unknown: 'failed',
    };
    if (!statuses[event.type]) return;
    this.update(event.sessionId, {
      sessionUpdate: event.type === 'tool_requested' ? 'tool_call' : 'tool_call_update',
      toolCallId: event.payload.callId,
      status: statuses[event.type],
      ...(event.type === 'tool_requested'
        ? { title: event.payload.name, kind: 'other', rawInput: event.payload.input }
        : {}),
      ...(typeof event.payload.output === 'string'
        ? { content: [{ type: 'content', content: { type: 'text', text: event.payload.output } }] }
        : {}),
    });
  }
  private approve(sessionId: string, call: ToolCall, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.closing) return Promise.resolve(false);
    const id = `permission-${++this.nextId}`;
    return new Promise((resolve) => {
      const finish = (approved: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.permissions.delete(id);
        resolve(approved);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, 120_000);
      this.permissions.set(id, { sessionId, resolve: finish });
      signal.addEventListener('abort', abort, { once: true });
      this.send({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: call.id,
            title: call.name,
            kind: 'other',
            status: 'pending',
            rawInput: call.input,
          },
          options: [
            { optionId: 'allow', name: '允许本次', kind: 'allow_once' },
            { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
          ],
        },
      });
    });
  }
  async handle(value: unknown): Promise<void> {
    const envelope = z
      .object({
        jsonrpc: z.literal('2.0'),
        id: z.union([z.string(), z.number().int()]).optional(),
        method: z.string().optional(),
        params: z.unknown().optional(),
        result: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .safeParse(value);
    if (!envelope.success) {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const message = envelope.data;
    if (!message.method) {
      if (typeof message.id === 'string') {
        const permission = this.permissions.get(message.id);
        const result = z
          .object({
            outcome: z.object({ outcome: z.literal('selected'), optionId: z.literal('allow') }),
          })
          .safeParse(message.result);
        permission?.resolve(!message.error && result.success);
      }
      return;
    }
    if (message.id === undefined && message.method !== 'session/cancel') return;
    try {
      const result = await this.dispatch(message.method, message.params);
      if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      if (message.id === undefined) return;
      const code =
        error instanceof z.ZodError ? -32602 : error instanceof RpcError ? error.code : -32603;
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code,
          message:
            error instanceof z.ZodError
              ? 'Invalid params'
              : error instanceof RpcError
                ? error.message
                : 'Bruin operation failed; check local configuration and session state',
        },
      });
    }
  }
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (this.closing) throw new RpcError(-32603, 'Connection closing');
    if (method === 'initialize') {
      z.object({ protocolVersion: z.number().int().positive() }).parse(params);
      if (this.initialized) throw new RpcError(-32600, 'Already initialized');
      this.initialized = true;
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {}, mcpCapabilities: {} },
        agentInfo: { name: 'bruin', version: '1.0.0' },
        authMethods: [],
      };
    }
    if (!this.initialized) throw new RpcError(-32600, 'Initialize first');
    if (method === 'session/new') {
      const p = newParams.parse(params);
      if (this.entries.size >= 20) throw new RpcError(-32603, 'Session limit reached');
      const root = fs.realpathSync(p.cwd);
      if (!fs.statSync(root).isDirectory()) throw new RpcError(-32602, 'cwd must be a directory');
      const servers = p.mcpServers.map((server) =>
        mcpServerSchema.parse({
          ...server,
          transport: 'stdio',
          envNames: server.env.map((item) => item.name),
        }),
      );
      if (new Set(servers.map((server) => server.name)).size !== servers.length)
        throw new RpcError(-32602, 'Duplicate MCP server name');
      const env: Record<string, Record<string, string>> = Object.create(null);
      for (const server of p.mcpServers)
        env[server.name] = Object.fromEntries(server.env.map((item) => [item.name, item.value]));
      const session = this.store.createSession(root, findProfile(this.modelAlias));
      const view = new Proxy(this.store, {
        get: (target, property) => {
          if (property === 'append')
            return (id: string, type: SessionEvent['type'], payload: Record<string, unknown>) => {
              const event = target.append(id, type, payload);
              if (id === session.id) this.toolEvent(event);
              return event;
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const services = new RuntimeServices(
        view,
        this.executor,
        createSubagentRunner(view, this.executor, (mode) =>
          this.gateway(mode === 'read-only', mode),
        ),
        {
          servers: [
            ...loadConfig().mcpServers.filter(
              (server) => !servers.some((item) => item.name === server.name),
            ),
            ...servers,
          ],
          env,
        },
      );
      const runner = new AgentRunner(
        view,
        this.gateway(false),
        this.executor,
        {
          text: (text) =>
            this.update(session.id, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            }),
          notice: (text) => {
            if (!text.includes(': 完成\n') && !text.includes(': 失败\n'))
              this.update(session.id, {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `\n${text}\n` },
              });
          },
          approve: (call, _reason, signal) => this.approve(session.id, call, signal),
        },
        services,
      );
      this.entries.set(session.id, { session, services, runner });
      return { sessionId: session.id };
    }
    if (method !== 'session/prompt' && method !== 'session/cancel')
      throw new RpcError(-32601, 'Method not found');
    const p = sessionParams.parse(params);
    const entry = this.entries.get(p.sessionId);
    if (!entry) throw new RpcError(-32602, 'Unknown session');
    if (method === 'session/cancel') {
      entry.controller?.abort();
      return {};
    }
    const prompt = promptParams
      .parse(params)
      .prompt.map((part) =>
        part.type === 'text'
          ? part.text
          : `Resource link (reference only): ${JSON.stringify(part)}`,
      )
      .join('\n');
    if (!prompt.trim() || prompt.length > 500_000)
      throw new RpcError(-32602, 'Invalid prompt length');
    if (entry.run) throw new RpcError(-32600, 'Session is busy');
    const controller = new AbortController();
    const lease = entry.services.sessionLeases.retain(entry.session.id, controller);
    entry.controller = controller;
    try {
      entry.runner.recover(entry.session);
      if (needsUnknownReview(this.store.events(entry.session.id)))
        throw new RpcError(
          -32603,
          'Session has uncertain tool results; inspect the local session and workspace before continuing',
        );
      entry.run = entry.runner.run(entry.session, prompt, controller.signal);
      await entry.run;
      return {
        stopReason:
          turnState(this.store.events(entry.session.id)) === 'paused'
            ? 'max_turn_requests'
            : 'end_turn',
      };
    } catch (error) {
      if (controller.signal.aborted) return { stopReason: 'cancelled' };
      throw error;
    } finally {
      lease.release();
      entry.controller = undefined;
      entry.run = undefined;
    }
  }
  async close() {
    this.closing = true;
    for (const entry of this.entries.values()) entry.controller?.abort();
    for (const permission of [...this.permissions.values()]) permission.resolve(false);
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.run));
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.services.close()));
    this.entries.clear();
  }
}
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export async function runAcp(
  modelAlias?: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const store = new SqliteEventStore(path.join(dataDir(), 'sessions.sqlite'));
  const executor = new ProcessExecutor();
  const server = new AcpServer(
    store,
    executor,
    (message) => output.write(JSON.stringify(message) + '\n'),
    modelAlias,
  );
  let stopped = false;
  const stop = () => {
    stopped = true;
    input.destroy();
  };
  output.on('error', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let buffer = '';
  try {
    for await (const chunk of input.setEncoding('utf8')) {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 1_000_000) throw new Error('ACP message too large');
        if (!line.trim()) continue;
        try {
          void server.handle(JSON.parse(line)).catch(stop);
        } catch {
          output.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            }) + '\n',
          );
        }
      }
      if (Buffer.byteLength(buffer) > 1_000_000) throw new Error('ACP message too large');
    }
    if (buffer.trim())
      output.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Incomplete JSON line' },
        }) + '\n',
      );
  } catch (error) {
    if (!stopped) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    output.removeListener('error', stop);
    await server.close();
    await executor.close();
    store.close();
  }
}
