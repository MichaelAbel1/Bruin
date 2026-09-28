import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteEventStore } from '../storage/event-store.js';
import { AgentRunner } from '../core/agent.js';
import { RuntimeServices } from '../runtime/services.js';
import {
  approvePlan,
  planBlocks,
  planState,
  setPlanMode,
  setPlanProgress,
} from '../runtime/plan.js';
import { loadConfig, mcpServerSchema, saveConfig } from '../config.js';
import { McpManager } from '../runtime/mcp.js';
import type { ModelGateway } from '../providers/gateway.js';
import type { ToolExecutor } from '../executor/client.js';
import type { ModelProfile, ToolCall, ToolResult } from '../core/types.js';

const profile: ModelProfile = {
  alias: 'local',
  provider: 'openai-compatible',
  model: 'mock',
  baseUrl: 'http://localhost:9999/v1',
};
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-runtime-'));
  const previous = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const store = new SqliteEventStore(path.join(dir, 'home', 'db.sqlite'));
  const session = store.createSession(dir, profile);
  return {
    dir,
    store,
    session,
    close() {
      store.close();
      if (previous === undefined) delete process.env.BRUIN_HOME;
      else process.env.BRUIN_HOME = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('planning mode persists approval and blocks mutations before approval', async () => {
  const f = fixture();
  const calls: ToolCall[][] = [
    [{ id: 'plan', name: 'update_plan', input: { steps: ['Inspect', 'Edit'] } }],
    [{ id: 'write', name: 'write_file', input: { path: 'x', content: 'a' } }],
    [],
  ];
  let executed = false;
  const gateway: ModelGateway = {
    async complete() {
      return { text: '', calls: calls.shift() ?? [] };
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      executed = true;
      return { output: 'ok', isError: false };
    },
    async close() {},
  };
  const services = new RuntimeServices(f.store, executor, async () => {});
  try {
    setPlanMode(f.store, f.session.id, true);
    const runner = new AgentRunner(
      f.store,
      gateway,
      executor,
      {
        text() {},
        notice() {},
        async approve() {
          return true;
        },
      },
      services,
    );
    await runner.run(f.session, 'Make a plan');
    await runner.run(f.session, 'Try executing before approval');
    const events = f.store.events(f.session.id);
    assert.equal(executed, false);
    assert.ok(
      events.some((event) => event.type === 'tool_denied' && event.payload.callId === 'write'),
    );
    assert.deepEqual(planState(events).steps, ['Inspect', 'Edit']);
    assert.equal(planState(events).approved, false);
    approvePlan(f.store, f.session.id);
    assert.equal(
      planBlocks(
        { id: 'next', name: 'write_file', input: {} },
        planState(f.store.events(f.session.id)),
      ),
      false,
    );
    assert.equal(setPlanProgress(f.store, f.session.id, 0, 'completed').progress[0], 'completed');
  } finally {
    await services.close();
    f.close();
  }
});
test('agent task creation requires approval and writes a workspace snapshot', async () => {
  const f = fixture();
  const executor: ToolExecutor = {
    async execute() {
      throw new Error('unused');
    },
    async close() {},
  };
  const services = new RuntimeServices(f.store, executor, async () => {});
  let turns = 0;
  const gateway: ModelGateway = {
    async complete() {
      turns++;
      return turns === 1
        ? {
            text: '',
            calls: [
              {
                id: 'task',
                name: 'create_task',
                input: { title: 'Build API', description: 'Implement endpoints', dependencies: [] },
              },
            ],
          }
        : { text: 'done', calls: [] };
    },
  };
  try {
    const runner = new AgentRunner(
      f.store,
      gateway,
      executor,
      {
        text() {},
        notice() {},
        async approve() {
          return true;
        },
      },
      services,
    );
    await runner.run(f.session, 'create task');
    const task = f.store.listTasks(f.session.id)[0];
    assert.equal(task.description, 'Implement endpoints');
    assert.ok(fs.existsSync(path.join(f.dir, '.tasks', `${task.id}.json`)));
    const cycle = await services.execute(
      { id: 'bad', name: 'update_task', input: { id: task.id, addBlockedBy: [task.id] } },
      f.session,
      new AbortController().signal,
    );
    assert.equal(cycle.isError, true);
    assert.match(cycle.output, /形成环/);
  } finally {
    await services.close();
    f.close();
  }
});

test('worktree, hooks, background task and read-only subagent use durable events', async () => {
  const f = fixture();
  let runChild = 0;
  const output: ToolResult = { output: 'done', isError: false };
  const executor: ToolExecutor = {
    async execute() {
      return output;
    },
    async close() {},
  };
  const services = new RuntimeServices(f.store, executor, async (child) => {
    runChild++;
    f.store.append(child.id, 'assistant', { text: 'research complete', calls: [] });
  });
  try {
    execFileSync('git', ['init', '-q'], { cwd: f.dir });
    fs.writeFileSync(path.join(f.dir, 'README.md'), 'hello');
    execFileSync('git', ['add', 'README.md'], { cwd: f.dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'],
      { cwd: f.dir },
    );
    const config = loadConfig();
    config.hooks.push({ name: 'before', event: 'before_tool', command: 'true', enabled: true });
    saveConfig(config);
    await services.runHooks('before_tool', f.session, new AbortController().signal);
    const worktree = await services.execute(
      { id: 'w', name: 'create_worktree', input: { name: 'research' } },
      f.session,
      new AbortController().signal,
    );
    assert.equal(fs.existsSync(path.join(worktree.output, 'README.md')), true);
    const listed = await services.execute(
      { id: 'l', name: 'list_worktrees', input: {} },
      f.session,
      new AbortController().signal,
    );
    assert.match(listed.output, /research/);
    const subagent = await services.execute(
      { id: 's', name: 'spawn_subagent', input: { prompt: 'inspect', worktree: worktree.output } },
      f.session,
      new AbortController().signal,
    );
    const subagentId = subagent.output.split(': ')[1];
    await new Promise((resolve) => setImmediate(resolve));
    const childStatus = await services.execute(
      { id: 'ss', name: 'subagent_status', input: { id: subagentId } },
      f.session,
      new AbortController().signal,
    );
    assert.match(childStatus.output, /research complete/);
    assert.equal(runChild, 1);
    const background = await services.execute(
      { id: 'b', name: 'start_background', input: { command: 'echo done' } },
      f.session,
      new AbortController().signal,
    );
    const backgroundId = background.output.split(': ')[1];
    await new Promise((resolve) => setImmediate(resolve));
    const status = await services.execute(
      { id: 'bs', name: 'background_status', input: { id: backgroundId } },
      f.session,
      new AbortController().signal,
    );
    assert.match(status.output, /completed/);
    assert.ok(f.store.events(f.session.id).some((event) => event.type === 'hook_finished'));
    assert.ok(f.store.events(f.session.id).some((event) => event.type === 'subagent_finished'));
    assert.ok(f.store.events(f.session.id).some((event) => event.type === 'background_finished'));
    const removed = await services.execute(
      { id: 'r', name: 'remove_worktree', input: { path: worktree.output } },
      f.session,
      new AbortController().signal,
    );
    assert.match(removed.output, /已移除/);
  } finally {
    await services.close();
    f.close();
  }
});

test('MCP stdio client lists and invokes a configured tool without inheriting secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-mcp-'));
  const script = path.join(dir, 'server.cjs');
  fs.writeFileSync(
    script,
    `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result;
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
      else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ text: message.params.arguments.text, inheritedSecret: process.env.BRUIN_TEST_SECRET ?? null }) }] };
      const reply = result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
      process.stdout.write(JSON.stringify(reply) + '\\n');
    });
  `,
  );
  const manager = new McpManager();
  process.env.BRUIN_TEST_SECRET = 'must-not-leak';
  try {
    const server = {
      name: 'local-test',
      transport: 'stdio' as const,
      command: process.execPath,
      args: [script],
      envNames: [],
    };
    const sandboxWorks = (() => {
      try {
        execFileSync(
          '/usr/bin/sandbox-exec',
          ['-p', '(version 1) (allow default)', '/usr/bin/true'],
          { stdio: 'ignore' },
        );
        return true;
      } catch {
        return false;
      }
    })();
    if (!sandboxWorks) {
      await assert.rejects(manager.listTools(server, dir), /沙箱不可用/);
      return;
    }
    const tools = await manager.listTools(server, dir);
    assert.equal(tools[0].name, 'echo');
    const result = await manager.callTool(server, 'echo', { text: 'hello' }, dir);
    assert.match(result.output, /hello/);
    assert.match(result.output, /inheritedSecret\\\":null/);
  } finally {
    await manager.close();
    delete process.env.BRUIN_TEST_SECRET;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remote MCP configuration requires HTTPS when leaving the local machine', () => {
  assert.equal(
    mcpServerSchema.safeParse({ name: 'remote', transport: 'http', url: 'http://example.com/mcp' })
      .success,
    false,
  );
  assert.equal(
    mcpServerSchema.safeParse({
      name: 'local',
      transport: 'http',
      url: 'http://127.0.0.1:3000/mcp',
    }).success,
    true,
  );
  assert.equal(
    mcpServerSchema.safeParse({ name: 'remote', transport: 'http', url: 'https://example.com/mcp' })
      .success,
    true,
  );
});
