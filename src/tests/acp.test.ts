import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { AcpServer, runAcp } from '../runtime/acp.js';
import { McpManager } from '../runtime/mcp.js';
import { SqliteEventStore } from '../storage/event-store.js';
import { saveConfig, loadConfig } from '../config.js';
import type { ModelGateway } from '../providers/gateway.js';

function fixture(gateway: ModelGateway) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-acp-'));
  const old = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  saveConfig({
    ...loadConfig(),
    profiles: [{ alias: 'test', provider: 'openai', model: 'mock' }],
    defaultProfile: 'test',
  });
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const messages: any[] = [];
  let effects = 0;
  const connect = () =>
    new AcpServer(
      store,
      {
        async execute() {
          effects++;
          return { output: 'written', isError: false };
        },
        async close() {},
      },
      (message) => messages.push(message),
      undefined,
      () => gateway,
    );
  let server = connect();
  let id = 0;
  return {
    dir,
    store,
    get server() {
      return server;
    },
    messages,
    effects: () => effects,
    async request(method: string, params: unknown) {
      const requestId = ++id;
      await server.handle({ jsonrpc: '2.0', id: requestId, method, params });
      return messages.find((message) => message.id === requestId);
    },
    async reconnect() {
      await server.close();
      messages.length = 0;
      server = connect();
    },
    async close() {
      await server.close();
      store.close();
      if (old === undefined) delete process.env.BRUIN_HOME;
      else process.env.BRUIN_HOME = old;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('ACP checks uncertain effects before another prompt and honors an explicit local review', async () => {
  let calls = 0;
  const f = fixture({
    async complete() {
      calls++;
      return { text: 'checked history', calls: [] };
    },
  });
  try {
    await f.request('initialize', { protocolVersion: 1 });
    const sessionId = (await f.request('session/new', { cwd: f.dir, mcpServers: [] })).result
      .sessionId;
    f.store.append(sessionId, 'assistant', {
      text: '',
      calls: [{ id: 'uncertain', name: 'shell', input: { command: 'external side effect' } }],
    });
    f.store.append(sessionId, 'tool_started', {
      callId: 'uncertain',
      name: 'shell',
      recovery: 'manual',
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await f.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'continue' }],
      });
      assert.equal(reply.error?.code, -32603);
      assert.match(reply.error.message, /uncertain tool results/);
      assert.equal(f.store.isLeased(sessionId), false);
    }
    assert.equal(calls, 0);
    assert.equal(f.effects(), 0);
    const events = f.store.events(sessionId);
    assert.equal(events.filter((event) => event.type === 'tool_unknown').length, 1);
    assert.equal(events.filter((event) => event.type === 'user').length, 0);
    const reviewedThrough = events.find((event) => event.type === 'tool_unknown')!.seq;
    f.store.append(sessionId, 'unknown_reviewed', {
      throughSeq: reviewedThrough,
      source: 'desktop',
    });
    const resumed = await f.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'continue after review' }],
    });
    assert.equal(resumed.result?.stopReason, 'end_turn');
    assert.equal(calls, 1);
    assert.equal(f.effects(), 0);
    assert.equal(f.store.isLeased(sessionId), false);
  } finally {
    await f.close();
  }
});

test('ACP reloads a saved session after reconnect and preserves tool results and review gates', async () => {
  let calls = 0;
  const f = fixture({
    async complete(_profile, messages) {
      if (++calls === 1)
        return {
          text: '',
          calls: [{ id: 'first-read', name: 'read_file', input: { path: 'file.txt' } }],
        };
      if (calls === 2) return { text: 'Initial answer.', calls: [] };
      assert.match(JSON.stringify(messages), /Original task.*written.*Initial answer/s);
      return { text: 'Continuing the original task.', calls: [] };
    },
  });
  try {
    fs.writeFileSync(path.join(f.dir, 'file.txt'), 'fixture');
    await f.request('initialize', { protocolVersion: 1 });
    const sessionId = (await f.request('session/new', { cwd: f.dir, mcpServers: [] })).result
      .sessionId;
    const send = (text: string) =>
      f.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    assert.equal((await send('Original task')).result.stopReason, 'end_turn');
    assert.equal(f.effects(), 1);
    await f.reconnect();
    assert.equal(
      (await f.request('initialize', { protocolVersion: 1 })).result.agentCapabilities.loadSession,
      true,
    );

    const other = path.join(f.dir, 'unrelated');
    fs.mkdirSync(other);
    assert.equal(
      (await f.request('session/load', { sessionId, cwd: other, mcpServers: [] })).error.code,
      -32602,
    );
    const load = () => f.request('session/load', { sessionId, cwd: f.dir, mcpServers: [] });
    const snapshot = f.store.events(sessionId);
    let previous: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = f.messages.length;
      assert.deepEqual((await load()).result, {});
      const replay = f.messages.slice(start, -1);
      const text = JSON.stringify(replay);
      assert.match(text, /Original task.*written.*Initial answer/s);
      assert.doesNotMatch(text, /request_permission|rawInput/);
      if (attempt) assert.deepEqual(replay, previous);
      previous = replay;
    }
    assert.deepEqual(f.store.events(sessionId), snapshot);
    assert.equal(calls, 2);
    assert.equal(f.effects(), 1);

    f.store.append(sessionId, 'assistant', {
      calls: [{ id: 'interrupted', name: 'shell', input: { command: 'external side effect' } }],
    });
    f.store.append(sessionId, 'tool_started', {
      callId: 'interrupted',
      name: 'shell',
      recovery: 'manual',
    });
    assert.match((await send('Resume')).error.message, /uncertain tool results/);
    assert.equal(calls, 2);
    const unknown = f.store.events(sessionId).at(-1)!;
    assert.equal(unknown.type, 'tool_unknown');
    f.store.append(sessionId, 'unknown_reviewed', { throughSeq: unknown.seq, source: 'desktop' });
    assert.equal((await send('Resume')).result.stopReason, 'end_turn');
    assert.equal(calls, 3);
    assert.equal(f.effects(), 1);
    assert.deepEqual(
      f.store
        .events(sessionId)
        .filter((event) => event.type === 'user')
        .map((event) => event.payload.text),
      ['Original task', 'Resume'],
    );
  } finally {
    await f.close();
  }
});

test('ACP reconciles interrupted reads and completed child receipts without replaying tools', async () => {
  const f = fixture({
    async complete(_profile, prompt) {
      assert.match(JSON.stringify(prompt), /Read interrupted/);
      assert.match(String(prompt[0].content), /recovered child finding/);
      return { text: 'reviewed history', calls: [] };
    },
  });
  try {
    await f.request('initialize', { protocolVersion: 1 });
    const sessionId = (await f.request('session/new', { cwd: f.dir, mcpServers: [] })).result
      .sessionId;
    const parent = f.store.getSession(sessionId)!;
    f.store.append(sessionId, 'assistant', {
      text: '',
      calls: [{ id: 'read', name: 'read_file', input: { path: 'source.txt' } }],
    });
    f.store.append(sessionId, 'tool_started', {
      callId: 'read',
      name: 'read_file',
      recovery: 'safe',
    });
    const child = f.store.createSession(f.dir, parent.profile);
    f.store.append(sessionId, 'subagent_started', {
      childId: child.id,
      prompt: 'inspect',
      workspace: f.dir,
      mode: 'read-only',
    });
    f.store.append(child.id, 'user', { text: 'inspect' });
    f.store.append(child.id, 'assistant', { text: 'recovered child finding', calls: [] });
    f.store.append(child.id, 'turn_completed', {});
    const result = await f.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'continue' }],
    });
    assert.equal(result.result?.stopReason, 'end_turn', JSON.stringify(result));
    assert.equal(f.effects(), 0);
    assert.equal(f.store.isLeased(sessionId), false);
    const events = f.store.events(sessionId);
    assert.equal(
      events.filter((event) => event.type === 'tool_finished' && event.payload.callId === 'read')
        .length,
      1,
    );
    assert.equal(
      events.filter((event) => event.type === 'subagent_finished' && event.payload.recovered)
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

for (const lateType of [
  'background_finished',
  'subagent_finished',
  'model_switched',
  'hook_finished',
] as const) {
  test(`ACP preserves the budget stop reason after ${lateType}`, async (t) => {
    const previous = process.env.BRUIN_MAX_STEPS;
    process.env.BRUIN_MAX_STEPS = '1';
    const f = fixture({
      async complete() {
        return {
          text: '',
          calls: [{ id: 'read', name: 'read_file', input: { path: 'source.txt' } }],
        };
      },
    });
    const append = f.store.append.bind(f.store);
    t.mock.method(f.store, 'append', (...args: Parameters<typeof append>) => {
      const result = append(...args);
      if (args[1] === 'turn_paused')
        append(args[0], lateType, { id: 'late', childId: 'late-child', status: 'completed' });
      return result;
    });
    try {
      fs.writeFileSync(path.join(f.dir, 'source.txt'), 'source');
      await f.request('initialize', { protocolVersion: 1 });
      const sessionId = (await f.request('session/new', { cwd: f.dir, mcpServers: [] })).result
        .sessionId;
      const response = await f.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'inspect' }],
      });
      assert.equal(response.result?.stopReason, 'max_turn_requests', JSON.stringify(response));
      assert.equal(f.effects(), 1);
      assert.equal(f.store.events(sessionId).at(-1)?.type, lateType);
      assert.equal(f.store.isLeased(sessionId), false);
    } finally {
      await f.close();
      if (previous === undefined) delete process.env.BRUIN_MAX_STEPS;
      else process.env.BRUIN_MAX_STEPS = previous;
    }
  });
}

test('ACP negotiates v1, validates capabilities, preserves streams and records normal sessions', async () => {
  const f = fixture({
    async complete(_profile, prompt, _signal, onText) {
      assert.match(JSON.stringify(prompt), /Resource link.*example.ts/);
      onText('Hello ');
      onText('IDE');
      return { text: 'Hello IDE', calls: [] };
    },
  });
  try {
    assert.equal((await f.request('session/new', {})).error.code, -32600);
    assert.equal((await f.request('initialize', { protocolVersion: 2 })).result.protocolVersion, 1);
    assert.equal((await f.request('session/new', { cwd: '.', mcpServers: [] })).error.code, -32602);
    const created = await f.request('session/new', { cwd: f.dir, mcpServers: [] });
    const sessionId = created.result.sessionId;
    assert.equal((await f.request('session/load', {})).error.code, -32602);
    assert.equal(
      (await f.request('session/prompt', { sessionId, prompt: [{ type: 'image', data: 'x' }] }))
        .error.code,
      -32602,
    );
    const reply = await f.request('session/prompt', {
      sessionId,
      prompt: [
        { type: 'text', text: 'Inspect' },
        { type: 'resource_link', uri: 'file:///example.ts', name: 'example.ts' },
      ],
    });
    assert.equal(reply.result.stopReason, 'end_turn');
    const chunks = f.messages.filter(
      (message) => message.params?.update.sessionUpdate === 'agent_message_chunk',
    );
    assert.equal(chunks.map((message) => message.params.update.content.text).join(''), 'Hello IDE');
    assert.equal(f.store.isLeased(sessionId), false);
    assert.equal(f.store.events(sessionId).at(-1)?.type, 'turn_completed');
  } finally {
    await f.close();
  }
});

for (const outcome of ['allow', 'reject', 'cancelled', 'invalid'] as const) {
  test(`ACP tool permission ${outcome} cannot bypass approval`, async () => {
    let calls = 0;
    const f = fixture({
      async complete() {
        if (++calls === 1)
          return {
            text: '',
            calls: [{ id: 'write', name: 'write_file', input: { path: 'a.txt', content: 'data' } }],
          };
        return { text: 'done', calls: [] };
      },
    });
    try {
      await f.request('initialize', { protocolVersion: 1 });
      const sessionId = (await f.request('session/new', { cwd: f.dir, mcpServers: [] })).result
        .sessionId;
      const running = f.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'write' }],
      });
      const deadline = Date.now() + 3000;
      while (!f.messages.some((message) => message.method === 'session/request_permission')) {
        if (Date.now() > deadline) throw new Error('permission timeout');
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(f.effects(), 0);
      assert.equal(
        (
          await f.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'overlap' }],
          })
        ).error.code,
        -32600,
      );
      const permission = f.messages.find(
        (message) => message.method === 'session/request_permission',
      );
      if (outcome === 'cancelled')
        await f.server.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      else
        await f.server.handle({
          jsonrpc: '2.0',
          id: permission.id,
          result: { outcome: { outcome: 'selected', optionId: outcome } },
        });
      const reply = await running;
      assert.equal(reply.result.stopReason, outcome === 'cancelled' ? 'cancelled' : 'end_turn');
      assert.equal(f.effects(), outcome === 'allow' ? 1 : 0);
      assert.equal(f.store.isLeased(sessionId), false);
      assert.ok(f.messages.some((message) => message.params?.update.sessionUpdate === 'tool_call'));
    } finally {
      await f.close();
    }
  });
}

test('session MCP environments stay per server and out of persisted config and events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-acp-env-'));
  const script = path.join(dir, 'server.cjs');
  fs.writeFileSync(
    script,
    `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const message=JSON.parse(line); if(message.id===undefined)return;
    const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:{tools:[{name:'env',description:process.env.ACP_SECRET,inputSchema:{type:'object'}}]};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
  });`,
  );
  const manager = new McpManager({ one: { ACP_SECRET: 'first' }, two: { ACP_SECRET: 'second' } });
  try {
    const server = {
      transport: 'stdio' as const,
      command: process.execPath,
      args: [script],
      envNames: ['ACP_SECRET'],
    };
    assert.equal(
      (await manager.listTools({ ...server, name: 'one' }, dir))[0].description,
      'first',
    );
    assert.equal(
      (await manager.listTools({ ...server, name: 'two' }, dir))[0].description,
      'second',
    );
    assert.equal(process.env.ACP_SECRET, undefined);
  } finally {
    await manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const f = fixture({
    async complete() {
      return { text: 'done', calls: [] };
    },
  });
  try {
    await f.request('initialize', { protocolVersion: 1 });
    await f.request('session/new', {
      cwd: f.dir,
      mcpServers: [
        {
          name: 'local',
          command: process.execPath,
          args: [],
          env: [{ name: 'ACP_SECRET', value: 'DO_NOT_PERSIST' }],
        },
      ],
    });
    assert.doesNotMatch(JSON.stringify(loadConfig()), /DO_NOT_PERSIST/);
    assert.doesNotMatch(
      JSON.stringify(f.store.listSessions().map((session) => f.store.events(session.id))),
      /DO_NOT_PERSIST/,
    );
  } finally {
    await f.close();
  }
});

test('ACP stdio emits protocol-only output and handles malformed JSON and EOF', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-acp-stdio-'));
  const old = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = dir;
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
  });
  try {
    const serving = runAcp(undefined, input, output);
    input.write('{invalid}\n');
    input.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      }) + '\n',
    );
    await serving;
    const messages = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(messages[0].error.code, -32700);
    assert.equal(messages[1].result.protocolVersion, 1);
  } finally {
    if (old === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
