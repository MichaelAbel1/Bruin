import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
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

test('task heartbeat survives storage errors, retries and stops after lost ownership', async (t) => {
  const f = fixture();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const services = new RuntimeServices(
    f.store,
    {
      async execute() {
        throw new Error('unused');
      },
      async close() {},
    },
    async () => {},
  );
  try {
    f.store.createTask(f.session.id, 'heartbeat task', []);
    const task = services.claimReadyTask(f.session)!;
    assert.ok(task);
    const renew = t.mock.method(f.store, 'renewTask');
    renew.mock.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY');
    });
    const stderr = t.mock.method(process.stderr, 'write', () => true);
    t.mock.timers.tick(60_000);
    assert.equal(renew.mock.callCount(), 1);
    assert.match(String(stderr.mock.calls[0].arguments[0]), /renewal failed/);
    t.mock.timers.tick(60_000);
    assert.equal(renew.mock.callCount(), 2);
    assert.equal(f.store.listTasks(f.session.id)[0].status, 'running');
    renew.mock.mockImplementation(() => false);
    t.mock.timers.tick(60_000);
    t.mock.timers.tick(60_000);
    assert.equal(renew.mock.callCount(), 3);
    services.finishClaimIfOpen(task.id);
    assert.equal(f.store.listTasks(f.session.id)[0].status, 'running');
  } finally {
    await services.close();
    f.close();
  }
});

test('worktree creation generates a valid default name even when the UUID starts with a digit', async (t) => {
  const f = fixture();
  const executor: ToolExecutor = {
    async execute() {
      throw new Error('unused');
    },
    async close() {},
  };
  const services = new RuntimeServices(f.store, executor, async () => {});
  try {
    execFileSync('git', ['init', '-q'], { cwd: f.dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-qm',
        'initial',
      ],
      { cwd: f.dir },
    );
    const uuid = t.mock.method(crypto, 'randomUUID', () => '01234567-89ab-4def-8123-456789abcdef');
    syncBuiltinESMExports();
    try {
      const result = await services.execute(
        { id: 'default-worktree', name: 'create_worktree', input: {} },
        f.session,
        new AbortController().signal,
      );
      assert.equal(result.isError, false, result.output);
      assert.match(path.basename(result.output), /^[a-z][a-z0-9-]{0,39}$/);
      assert.equal(fs.existsSync(path.join(result.output, '.git')), true);
    } finally {
      uuid.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    await services.close();
    f.close();
  }
});

for (const outcome of ['completed', 'failed', 'cancelled', 'synchronous-error'] as const) {
  test(`subagent session is leased until ${outcome} and rejects concurrent deletion or execution`, async () => {
    const f = fixture();
    let finish!: () => void;
    const services = new RuntimeServices(
      f.store,
      {
        async execute() {
          throw new Error('unused');
        },
        async close() {},
      },
      (child, _prompt, signal) => {
        assert.equal(f.store.isLeased(child.id), true);
        if (outcome === 'synchronous-error') throw new Error('sync failure');
        return new Promise<void>((resolve, reject) => {
          finish = () => {
            if (outcome === 'failed') reject(new Error('child failed'));
            else {
              f.store.append(child.id, 'turn_completed', {});
              resolve();
            }
          };
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    );
    try {
      const result = await services.execute(
        { id: 'spawn', name: 'spawn_subagent', input: { prompt: 'inspect' } },
        f.session,
        new AbortController().signal,
      );
      const id = result.output.split(': ')[1];
      // The callback may fail synchronously, but settlement is still asynchronous.
      if (outcome !== 'synchronous-error') {
        assert.equal(f.store.isLeased(id), true);
        assert.equal(f.store.isLeased(f.session.id), true);
        assert.throws(() => f.store.deleteSession(f.session.id), /运行中的会话/);
        assert.throws(() => f.store.acquireLease(id, 'other-process', 30_000), /另一个进程/);
        assert.throws(() => f.store.deleteSession(id), /运行中的会话/);
      }
      if (outcome === 'cancelled') await services.close();
      else {
        if (outcome !== 'synchronous-error') finish();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(f.store.isLeased(id), false);
      assert.equal(f.store.isLeased(f.session.id), false);
      const status = await services.execute(
        { id: 'status', name: 'subagent_status', input: { id } },
        f.session,
        new AbortController().signal,
      );
      assert.equal(
        JSON.parse(status.output).status,
        outcome === 'completed' ? 'completed' : 'failed',
      );
      f.store.deleteSession(id);
    } finally {
      await services.close();
      f.close();
    }
  });
}

test('paused subagent is reported as incomplete and its error survives host recreation', async () => {
  const f = fixture();
  const executor: ToolExecutor = {
    async execute() {
      throw new Error('unused');
    },
    async close() {},
  };
  const services = new RuntimeServices(f.store, executor, async (child) => {
    f.store.append(child.id, 'assistant', { text: 'unfinished research', calls: [] });
    f.store.append(child.id, 'turn_paused', { reason: 'step_limit' });
  });
  let restored: RuntimeServices | undefined;
  try {
    const result = await services.execute(
      { id: 'spawn', name: 'spawn_subagent', input: { prompt: 'inspect' } },
      f.session,
      new AbortController().signal,
    );
    const id = result.output.split(': ')[1];
    await new Promise((resolve) => setImmediate(resolve));
    for (const service of [
      services,
      (restored = new RuntimeServices(f.store, executor, async () => {})),
    ]) {
      const status = JSON.parse(
        (
          await service.execute(
            { id: 'status', name: 'subagent_status', input: { id } },
            f.session,
            new AbortController().signal,
          )
        ).output,
      );
      assert.equal(status.status, 'failed');
      assert.match(status.error, /任务尚未完成/);
      assert.equal(status.answer, 'unfinished research');
    }
    assert.equal(
      f.store.events(f.session.id).find((event) => event.type === 'subagent_finished')?.payload
        .status,
      'failed',
    );
  } finally {
    await restored?.close();
    await services.close();
    f.close();
  }
});

test('cancelled runtime operations do not save memory or spawn a child', async () => {
  const f = fixture();
  let spawned = false;
  const services = new RuntimeServices(
    f.store,
    {
      async execute() {
        throw new Error('unused');
      },
      async close() {},
    },
    async () => {
      spawned = true;
    },
  );
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      services.execute(
        {
          id: 'memory',
          name: 'save_memory',
          input: { key: 'note', content: 'should not be saved' },
        },
        f.session,
        controller.signal,
      ),
      /已取消/,
    );
    await assert.rejects(
      services.execute(
        { id: 'spawn', name: 'spawn_subagent', input: { prompt: 'inspect' } },
        f.session,
        controller.signal,
      ),
      /已取消/,
    );
    assert.deepEqual(f.store.listMemory(f.session.workspace), []);
    assert.equal(spawned, false);
    assert.equal(
      f.store.events(f.session.id).some((event) => event.type === 'subagent_started'),
      false,
    );
  } finally {
    await services.close();
    f.close();
  }
});

test('a final reply with unfinished approved plan steps reports the outstanding work', async () => {
  const f = fixture();
  const notices: string[] = [];
  const runner = new AgentRunner(
    f.store,
    {
      async complete() {
        return { text: 'Please clarify the expected output.', calls: [] };
      },
    },
    {
      async execute() {
        throw new Error('unused');
      },
      async close() {},
    },
    {
      text() {},
      notice(message) {
        notices.push(message);
      },
      async approve() {
        return false;
      },
    },
  );
  try {
    setPlanMode(f.store, f.session.id, true);
    f.store.append(f.session.id, 'plan_updated', { steps: ['Inspect', 'Verify'] });
    approvePlan(f.store, f.session.id);
    setPlanProgress(f.store, f.session.id, 0, 'completed');
    await runner.run(f.session, 'continue');
    assert.ok(notices.some((message) => message.includes('1 个步骤未标记完成')));
    assert.equal(f.store.events(f.session.id).at(-1)?.type, 'turn_completed');
    assert.equal(planState(f.store.events(f.session.id)).progress[1], undefined);
  } finally {
    f.close();
  }
});

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
  let hookRequiresSandbox = false;
  const output: ToolResult = { output: 'done', isError: false };
  const executor: ToolExecutor = {
    async execute(request) {
      if (request.name === 'shell' && request.input.command === 'true')
        hookRequiresSandbox = request.requireSandbox === true;
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
    assert.equal(hookRequiresSandbox, true);
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

test('MCP stdio client supports special workspace paths without inheriting secrets', async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), process.platform === 'win32' ? 'bruin-mcp-' : 'bruin-mcp-"\\-'),
  );
  const script = path.join(dir, 'server.cjs');
  const launches = path.join(dir, 'launches.txt');
  fs.writeFileSync(
    script,
    `
    const readline = require('node:readline');
    require('node:fs').appendFileSync(${JSON.stringify(launches)}, 'start\\n');
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
    const [tools, duplicate] = await Promise.all([
      manager.listTools(server, dir),
      manager.listTools(server, dir),
    ]);
    assert.equal(tools[0].name, 'echo');
    assert.equal(duplicate[0].name, 'echo');
    assert.equal(fs.readFileSync(launches, 'utf8').trim(), 'start');
    const result = await manager.callTool(server, 'echo', { text: 'hello' }, dir);
    assert.match(result.output, /hello/);
    assert.match(result.output, /inheritedSecret\\\":null/);

    if (process.platform === 'win32') {
      const previousPath = process.env.PATH;
      const windowsManager = new McpManager();
      try {
        process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${previousPath ?? ''}`;
        const byFilename = await windowsManager.listTools(
          { ...server, name: 'windows-filename', command: path.basename(process.execPath) },
          dir,
        );
        assert.equal(byFilename[0].name, 'echo');
      } finally {
        await windowsManager.close();
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    }

    // Verify BRUIN_ENFORCE_SANDBOX enforces sandbox on platforms without one
    const oldEnforce = process.env.BRUIN_ENFORCE_SANDBOX;
    const oldPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const enforceManager = new McpManager();
    try {
      process.env.BRUIN_ENFORCE_SANDBOX = '1';
      Object.defineProperty(process, 'platform', { value: 'win32' });
      await assert.rejects(enforceManager.listTools(server, dir), /强制沙箱模式/);
    } finally {
      await enforceManager.close();
      if (oldEnforce === undefined) delete process.env.BRUIN_ENFORCE_SANDBOX;
      else process.env.BRUIN_ENFORCE_SANDBOX = oldEnforce;
      if (oldPlatform) Object.defineProperty(process, 'platform', oldPlatform);
    }
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

test('services.execute returns isError for pre-execution validation and throws on runtime failure', async () => {
  const f = fixture();
  const executor: ToolExecutor = {
    async execute() {
      return { output: 'done', isError: false };
    },
    async close() {},
  };
  const services = new RuntimeServices(f.store, executor, async () => {});
  try {
    // Deterministic pre-execution check: unconfigured server
    const mcpRes = await services.execute(
      { id: 'm1', name: 'mcp_list_tools', input: { server: 'nonexistent' } },
      f.session,
      new AbortController().signal,
    );
    assert.equal(mcpRes.isError, true);
    assert.match(mcpRes.output, /MCP 服务器未配置/);

    // Deterministic pre-execution check: invalid worktree name
    const badNameRes = await services.execute(
      { id: 'w0', name: 'create_worktree', input: { name: '123-bad' } },
      f.session,
      new AbortController().signal,
    );
    assert.equal(badNameRes.isError, true);
    assert.match(badNameRes.output, /工作树名称必须以字母开头/);

    // Deterministic pre-execution check: non-existent worktree path in remove_worktree
    const removeRes = await services.execute(
      {
        id: 'w_rem',
        name: 'remove_worktree',
        input: { path: '/tmp/nonexistent-worktree-path-12345' },
      },
      f.session,
      new AbortController().signal,
    );
    assert.equal(removeRes.isError, true);
    assert.match(removeRes.output, /工作树路径不存在/);

    // Deterministic pre-execution check: non-existent worktree path in spawn_subagent
    const spawnRes = await services.execute(
      {
        id: 's_sub',
        name: 'spawn_subagent',
        input: { prompt: 'research', worktree: '/tmp/nonexistent-worktree-path-12345' },
      },
      f.session,
      new AbortController().signal,
    );
    assert.equal(spawnRes.isError, true);
    assert.match(spawnRes.output, /工作树路径不存在/);

    // Deterministic pre-execution check: real path outside worktrees when dataDir/worktrees does not exist
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-outside-'));
    try {
      const remOutside = await services.execute(
        {
          id: 'w_rem2',
          name: 'remove_worktree',
          input: { path: outsideDir },
        },
        f.session,
        new AbortController().signal,
      );
      assert.equal(remOutside.isError, true);
      assert.match(remOutside.output, /只能移除 Bruin 管理的工作树/);

      const spawnOutside = await services.execute(
        {
          id: 's_sub2',
          name: 'spawn_subagent',
          input: { prompt: 'research', worktree: outsideDir },
        },
        f.session,
        new AbortController().signal,
      );
      assert.equal(spawnOutside.isError, true);
      assert.match(spawnOutside.output, /子 Agent 只能使用 Bruin 创建的工作树/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }

    // Check create_worktree and start_background when workspace does not exist
    const nonExistentSession = f.store.createSession('/tmp/nonexistent-workspace-dir-999', profile);
    const badWorktree = await services.execute(
      { id: 'w_bad', name: 'create_worktree', input: { name: 'validname' } },
      nonExistentSession,
      new AbortController().signal,
    );
    assert.equal(badWorktree.isError, true);
    assert.match(badWorktree.output, /工作区目录不存在/);

    const badBg = await services.execute(
      { id: 'bg_bad', name: 'start_background', input: { command: 'echo hi' } },
      nonExistentSession,
      new AbortController().signal,
    );
    assert.equal(badBg.isError, true);
    assert.match(badBg.output, /工作区目录不存在/);

    // runHooks rejects on missing unmanaged workspace
    await assert.rejects(
      services.runHooks('turn_started', nonExistentSession, new AbortController().signal),
      /工作区目录不存在/,
    );

    // runHooks gracefully ignores unmaterialized managed workspace
    const managedDir = path.join(f.dir, 'workspaces', '20260928-120000-11223344');
    const managedSession = f.store.createManagedSession(managedDir, profile);
    await services.runHooks('turn_started', managedSession, new AbortController().signal);

    // Execution phase error: git worktree on non-git directory must throw so AgentRunner records tool_unknown
    await assert.rejects(
      services.execute(
        { id: 'w1', name: 'list_worktrees', input: {} },
        f.session,
        new AbortController().signal,
      ),
      /git/i,
    );
  } finally {
    await services.close();
    f.close();
  }
});

test('services.close() releases claimed tasks back to pending state', async () => {
  const f = fixture();
  const executor: ToolExecutor = {
    async execute() {
      return { output: 'done', isError: false };
    },
    async close() {},
  };
  const task = f.store.createTask(f.session.id, 'Task to claim and release', []);
  const services = new RuntimeServices(f.store, executor, async () => {});
  try {
    const claimed = services.claimReadyTask(f.session);
    assert.ok(claimed);
    assert.equal(claimed.id, task.id);
    assert.equal(f.store.getTask(f.session.id, task.id)?.status, 'running');

    await services.close();
    assert.equal(f.store.getTask(f.session.id, task.id)?.status, 'pending');
    assert.equal(f.store.getTask(f.session.id, task.id)?.owner, undefined);
  } finally {
    f.close();
  }
});

test('background settlement does not emit an unhandled rejection when event persistence fails', async (t) => {
  const f = fixture();
  let finish!: (result: ToolResult) => void;
  const services = new RuntimeServices(
    f.store,
    {
      execute: () =>
        new Promise<ToolResult>((resolve) => {
          finish = resolve;
        }),
      async close() {},
    },
    async () => {},
  );
  try {
    const result = await services.execute(
      { id: 'background', name: 'start_background', input: { command: 'pwd' } },
      f.session,
      new AbortController().signal,
    );
    assert.equal(result.isError, false);
    assert.throws(() => f.store.deleteSession(f.session.id), /运行中的会话/);
    const append = f.store.append.bind(f.store);
    t.mock.method(
      f.store,
      'append',
      (...[id, type, payload]: Parameters<SqliteEventStore['append']>) => {
        if (type === 'background_finished') throw new Error('simulated storage failure');
        return append(id, type, payload);
      },
    );
    finish({ output: 'done', isError: false });
    await services.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.store.isLeased(f.session.id), false);
  } finally {
    await services.close();
    f.close();
  }
});

test('foreground can resume while background work retains the parent lease across processes', async () => {
  const f = fixture();
  const other = new SqliteEventStore(path.join(f.dir, 'home', 'db.sqlite'));
  const completions: Array<() => void> = [];
  let finishChild!: () => void;
  const services = new RuntimeServices(
    f.store,
    {
      execute: (_request, signal) =>
        new Promise<ToolResult>((resolve, reject) => {
          completions.push(() => resolve({ output: 'done', isError: false }));
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
      async close() {},
    },
    (child, _prompt, signal) =>
      new Promise<void>((resolve, reject) => {
        finishChild = () => {
          f.store.append(child.id, 'turn_completed', {});
          resolve();
        };
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
  );
  const foreground = services.sessionLeases.retain(f.session.id, new AbortController());
  let resumed: ReturnType<RuntimeServices['sessionLeases']['retain']> | undefined;
  const run = (name: ToolCall['name'], input: Record<string, unknown>) =>
    services.execute({ id: name, name, input }, f.session, new AbortController().signal);
  try {
    await run('start_background', { command: 'first' });
    const second = await run('start_background', { command: 'second' });
    const child = await run('spawn_subagent', { prompt: 'inspect' });
    foreground.release();
    assert.throws(() => other.deleteSession(f.session.id), /运行中的会话/);
    assert.throws(() => other.acquireLease(f.session.id, 'other', 30_000), /另一个进程/);
    resumed = services.sessionLeases.retain(f.session.id, new AbortController());
    assert.equal(resumed.owner, foreground.owner);
    completions[0]();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(other.isLeased(f.session.id), true);
    await run('cancel_background', { id: second.output.split(': ')[1] });
    finishChild();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(other.isLeased(child.output.split(': ')[1]), false);
    assert.equal(other.isLeased(f.session.id), true);
    resumed.release();
    assert.equal(other.isLeased(f.session.id), false);
    const events = f.store.events(f.session.id);
    assert.equal(events.filter((event) => event.type === 'background_finished').length, 2);
    assert.equal(events.filter((event) => event.type === 'subagent_finished').length, 1);
    assert.equal(
      events.find(
        (event) =>
          event.type === 'background_finished' && event.payload.id === second.output.split(': ')[1],
      )?.payload.status,
      'cancelled',
    );
    other.deleteSession(f.session.id);
  } finally {
    foreground.release();
    resumed?.release();
    await services.close();
    other.close();
    f.close();
  }
});

test('save_memory handles validation errors as isError in services.execute', async () => {
  const f = fixture();
  const executor: ToolExecutor = {
    async execute() {
      return { output: 'done', isError: false };
    },
    async close() {},
  };
  const services = new RuntimeServices(f.store, executor, async () => {});
  try {
    const invalidKeyRes = await services.execute(
      {
        id: 'sm1',
        name: 'save_memory',
        input: { key: 'invalid key with spaces!', content: 'test' },
      },
      f.session,
      new AbortController().signal,
    );
    assert.equal(invalidKeyRes.isError, true);
    assert.match(invalidKeyRes.output, /记忆名称或内容无效/);

    const emptyContentRes = await services.execute(
      { id: 'sm2', name: 'save_memory', input: { key: 'valid_key', content: '   ' } },
      f.session,
      new AbortController().signal,
    );
    assert.equal(emptyContentRes.isError, true);
    assert.match(emptyContentRes.output, /记忆名称或内容无效/);

    const validRes = await services.execute(
      { id: 'sm3', name: 'save_memory', input: { key: 'valid_key', content: 'good content' } },
      f.session,
      new AbortController().signal,
    );
    assert.equal(validRes.isError, false);
    assert.equal(validRes.output, '工作区记忆已保存');
  } finally {
    await services.close();
    f.close();
  }
});

test('save_memory rethrows unexpected store/database errors instead of returning isError', async () => {
  const f = fixture();
  const executor: ToolExecutor = {
    async execute() {
      return { output: 'done', isError: false };
    },
    async close() {},
  };
  const services = new RuntimeServices(f.store, executor, async () => {});
  try {
    f.store.close();
    await assert.rejects(
      () =>
        services.execute(
          {
            id: 'sm4',
            name: 'save_memory',
            input: { key: 'valid_key', content: 'test content' },
          },
          f.session,
          new AbortController().signal,
        ),
      /database.*not open|SqliteError/i,
    );
  } finally {
    await services.close();
  }
});
