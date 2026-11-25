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
import { recoverSession } from '../core/recovery.js';
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

test('a failed result write waits for siblings and leaves the completed child available for recovery', async (t) => {
  const f = fixture();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let finishSibling!: () => void;
  const siblingGate = new Promise<void>((resolve) => {
    finishSibling = resolve;
  });
  const services = new RuntimeServices(
    f.store,
    {
      async execute() {
        throw new Error('unused');
      },
      async close() {},
    },
    async (child, prompt) => {
      f.store.append(child.id, 'user', { text: prompt });
      await (prompt === 'inspect' ? gate : siblingGate);
      f.store.append(child.id, 'assistant', {
        text: prompt === 'inspect' ? 'verified result' : 'sibling result',
        calls: [],
      });
      f.store.append(child.id, 'turn_completed', {});
    },
  );
  const append = f.store.append.bind(f.store);
  let attempts = 0;
  let failWrites = true;
  t.mock.method(f.store, 'append', (...args: Parameters<typeof append>) => {
    if (failWrites && args[1] === 'subagent_finished' && args[2].answer === 'verified result') {
      attempts++;
      throw new Error('injected receipt write failure');
    }
    return append(...args);
  });
  const signal = new AbortController().signal;
  try {
    const spawned = await services.execute(
      { id: 'spawn', name: 'spawn_subagent', input: { prompt: 'inspect' } },
      f.session,
      signal,
    );
    const id = spawned.output.split(': ')[1];
    const sibling = await services.execute(
      { id: 'spawn-sibling', name: 'spawn_subagent', input: { prompt: 'verify' } },
      f.session,
      signal,
    );
    assert.equal(sibling.isError, false);
    const siblingId = sibling.output.split(': ')[1];
    const waiting = services.waitForSubagents(f.session.id, signal);
    let settledEarly = false;
    void waiting.then(
      () => {
        settledEarly = true;
      },
      () => {
        settledEarly = true;
      },
    );
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2);
    assert.equal(f.store.isLeased(id), false);
    assert.equal(f.store.isLeased(siblingId), true);
    assert.equal(f.store.isLeased(f.session.id), true);
    assert.equal(settledEarly, false);
    finishSibling();
    await assert.rejects(waiting, /injected receipt write failure/);
    assert.equal(f.store.isLeased(siblingId), false);
    assert.equal(f.store.isLeased(f.session.id), false);
    assert.equal(
      f.store
        .events(f.session.id)
        .some((event) => event.type === 'subagent_finished' && event.payload.childId === id),
      false,
    );
    assert.equal(
      f.store
        .events(f.session.id)
        .find((event) => event.type === 'subagent_finished' && event.payload.childId === siblingId)
        ?.payload.answer,
      'sibling result',
    );
    const status = { id: 'status', name: 'subagent_status' as const, input: { id } };
    assert.equal(
      JSON.parse((await services.execute(status, f.session, signal)).output).status,
      'unknown',
    );
    const cancel = { id: 'cancel', name: 'cancel_subagent' as const, input: { id } };
    const uncertain = await services.execute(cancel, f.session, signal);
    assert.equal(uncertain.isError, true);
    assert.match(uncertain.output, /缺少完成记录/);
    failWrites = false;
    f.store.acquireLease(f.session.id, 'test-recover', 30_000);
    try {
      recoverSession(f.store, f.session.id);
    } finally {
      f.store.releaseLease(f.session.id, 'test-recover');
    }
    const recovered = JSON.parse((await services.execute(status, f.session, signal)).output);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.answer, 'verified result');
    const settled = await services.execute(cancel, f.session, signal);
    assert.equal(settled.isError, false);
    assert.equal(JSON.parse(settled.output).status, 'completed');
  } finally {
    finish();
    finishSibling();
    await services.close();
    f.close();
  }
});

for (const committed of [false, true]) {
  test(`the parent continues after a transient child receipt error (committed=${committed})`, async (t) => {
    const f = fixture();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const executor = {
      async execute() {
        throw new Error('unexpected executor call');
      },
      async close() {},
    };
    const services = new RuntimeServices(f.store, executor, async (child, prompt) => {
      f.store.append(child.id, 'user', { text: prompt });
      await gate;
      f.store.append(child.id, 'assistant', { text: 'child verification', calls: [] });
      f.store.append(child.id, 'turn_completed', {});
    });
    const append = f.store.append.bind(f.store);
    let writes = 0;
    t.mock.method(f.store, 'append', (...args: Parameters<typeof append>) => {
      if (args[1] === 'subagent_finished' && ++writes === 1) {
        if (committed) append(...args);
        throw new Error('temporary receipt failure');
      }
      return append(...args);
    });
    let calls = 0;
    const runner = new AgentRunner(
      f.store,
      {
        async complete(_profile, messages) {
          if (++calls === 1) {
            setImmediate(finish);
            return { text: 'waiting for verification', calls: [] };
          }
          assert.match(JSON.stringify(messages[0]), /child verification/);
          return { text: 'summarized verification', calls: [] };
        },
      },
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
    const controller = new AbortController();
    const parent = services.sessionLeases.retain(f.session.id, controller);
    try {
      const launched = await services.execute(
        { id: 'spawn', name: 'spawn_subagent', input: { prompt: 'verify the patch' } },
        f.session,
        controller.signal,
      );
      assert.equal(launched.isError, false);
      await runner.run(f.session, 'Report the verification', controller.signal);
      const events = f.store.events(f.session.id);
      const receipts = events.filter((event) => event.type === 'subagent_finished');
      assert.equal(calls, 2);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].payload.status, 'completed');
      assert.equal(receipts[0].payload.answer, 'child verification');
      assert.equal(writes, committed ? 1 : 2);
      assert.equal(events.at(-1)?.type, 'turn_completed');
    } finally {
      finish();
      parent.release();
      await services.close();
      f.close();
    }
  });
}

for (const duringReceipt of [false, true]) {
  test(`a displaced subagent owner leaves recovery to the new parent lease holder (during write=${duringReceipt})`, async (t) => {
    const f = fixture();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const services = new RuntimeServices(
      f.store,
      {
        async execute() {
          throw new Error('unused');
        },
        async close() {},
      },
      async (child, prompt) => {
        f.store.append(child.id, 'user', { text: prompt });
        await gate;
        f.store.append(child.id, 'assistant', { text: 'recovered from child turn', calls: [] });
        f.store.append(child.id, 'turn_completed', {});
      },
    );
    const signal = new AbortController().signal;
    const foreground = services.sessionLeases.retain(f.session.id, new AbortController());
    const observerStore = new SqliteEventStore(path.join(f.dir, 'home', 'db.sqlite'));
    try {
      const spawned = await services.execute(
        { id: 'spawn', name: 'spawn_subagent', input: { prompt: 'inspect' } },
        f.session,
        signal,
      );
      const id = spawned.output.split(': ')[1];
      const waiting = services.waitForSubagents(f.session.id, signal);
      const transferLease = () => {
        observerStore.releaseLease(f.session.id, foreground.owner);
        observerStore.acquireLease(f.session.id, 'new-owner', 30_000);
      };
      if (duringReceipt) {
        const append = f.store.append.bind(f.store);
        let transferred = false;
        t.mock.method(f.store, 'append', (...args: Parameters<typeof append>) => {
          if (args[1] === 'subagent_finished' && !transferred) {
            transferred = true;
            transferLease();
            throw new Error('receipt failed after lease transfer');
          }
          return append(...args);
        });
      } else transferLease();
      finish();
      await assert.rejects(waiting, /租约已失效/);
      assert.equal(observerStore.isLeased(id), false);
      assert.equal(
        observerStore.events(f.session.id).some((event) => event.type === 'subagent_finished'),
        false,
      );
      foreground.release();
      assert.equal(observerStore.renewLease(f.session.id, 'new-owner', 30_000), true);
      recoverSession(observerStore, f.session.id);
      const events = observerStore
        .events(f.session.id)
        .filter((event) => event.type === 'subagent_finished');
      assert.equal(events.length, 1);
      assert.equal(events[0].payload.status, 'completed');
      assert.equal(events[0].payload.answer, 'recovered from child turn');
    } finally {
      finish();
      foreground.release();
      observerStore.releaseLease(f.session.id, 'new-owner');
      observerStore.close();
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
    f.store.append(child.id, 'assistant', { text: '', calls: [] });
    f.store.append(child.id, 'assistant', {
      text: 'pause report',
      calls: [],
      synthetic: 'pause_report',
    });
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
    f.store.deleteSession(id);
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

for (const outcome of [
  'missing-completion',
  'cancelled-before-start',
  'cancelled-at-finish',
] as const) {
  test(`subagent does not report false completion: ${outcome}`, async (t) => {
    const f = fixture();
    let runs = 0;
    let signal: AbortSignal | undefined;
    let childController: AbortController | undefined;
    const services = new RuntimeServices(
      f.store,
      {
        async execute() {
          throw new Error('unused');
        },
        async close() {},
      },
      async (child, _prompt, childSignal) => {
        runs++;
        signal = childSignal;
        if (outcome === 'cancelled-at-finish') {
          // A provider may resolve even after lease loss has cancelled its signal.
          f.store.append(child.id, 'turn_completed', {});
          childController!.abort();
        }
      },
    );
    try {
      const retain = services.sessionLeases.retain.bind(services.sessionLeases);
      t.mock.method(services.sessionLeases, 'retain', (id: string, controller: AbortController) => {
        const lease = retain(id, controller);
        if (id !== f.session.id) {
          childController = controller;
          // Simulate lease loss before the scheduled child callback runs.
          if (outcome === 'cancelled-before-start') controller.abort();
        }
        return lease;
      });
      const result = await services.execute(
        { id: 'spawn', name: 'spawn_subagent', input: { prompt: 'inspect' } },
        f.session,
        new AbortController().signal,
      );
      const id = result.output.split(': ')[1];
      await new Promise<void>((resolve) => setImmediate(resolve));
      const status = JSON.parse(
        (
          await services.execute(
            { id: 'status', name: 'subagent_status', input: { id } },
            f.session,
            new AbortController().signal,
          )
        ).output,
      );
      assert.equal(status.status, 'failed');
      assert.match(status.error, outcome === 'missing-completion' ? /未正常完成/ : /已取消/);
      assert.equal(runs, outcome === 'cancelled-before-start' ? 0 : 1);
      if (outcome === 'cancelled-at-finish') assert.equal(signal?.aborted, true);
      assert.equal(f.store.isLeased(id), false);
      assert.equal(f.store.isLeased(f.session.id), false);
    } finally {
      await services.close();
      f.close();
    }
  });
}

for (const change of ['deleted', 'continued'] as const) {
  test(`subagent status keeps the durable answer after the child session is ${change}`, async () => {
    const f = fixture();
    const executor: ToolExecutor = {
      async execute() {
        throw new Error('unused');
      },
      async close() {},
    };
    const services = new RuntimeServices(f.store, executor, async (child) => {
      f.store.append(child.id, 'assistant', { text: 'durable finding', calls: [] });
      f.store.append(child.id, 'turn_completed', {});
    });
    let restored: RuntimeServices | undefined;
    try {
      const result = await services.execute(
        { id: 'spawn', name: 'spawn_subagent', input: { prompt: 'inspect' } },
        f.session,
        new AbortController().signal,
      );
      const id = result.output.split(': ')[1];
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (change === 'deleted') f.store.deleteSession(id);
      else {
        f.store.append(id, 'user', { text: 'an unrelated follow-up' });
        f.store.append(id, 'assistant', { text: 'unrelated answer', calls: [] });
        f.store.append(id, 'turn_completed', {});
      }
      restored = new RuntimeServices(f.store, executor, async () => {});
      for (const runtime of [services, restored]) {
        const status = JSON.parse(
          (
            await runtime.execute(
              { id: 'status', name: 'subagent_status', input: { id } },
              f.session,
              new AbortController().signal,
            )
          ).output,
        );
        assert.equal(status.status, 'completed');
        assert.equal(status.answer, 'durable finding');
      }
    } finally {
      await restored?.close();
      await services.close();
      f.close();
    }
  });
}

for (const timing of ['before-start', 'late-success', 'late-error'] as const) {
  test(`background lease cancellation is durable: ${timing}`, async (t) => {
    const f = fixture();
    let runs = 0;
    let controller!: AbortController;
    let finish!: () => void;
    const executor: ToolExecutor = {
      async execute() {
        runs++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        if (timing === 'late-error') throw new Error('cancelled command');
        return { output: 'late result', isError: false };
      },
      async close() {},
    };
    const services = new RuntimeServices(f.store, executor, async () => {});
    let restored: RuntimeServices | undefined;
    const retain = services.sessionLeases.retain.bind(services.sessionLeases);
    t.mock.method(services.sessionLeases, 'retain', (id: string, value: AbortController) => {
      controller = value;
      const lease = retain(id, value);
      if (timing === 'before-start') value.abort();
      return lease;
    });
    try {
      const started = await services.execute(
        { id: 'start', name: 'start_background', input: { command: 'test command' } },
        f.session,
        new AbortController().signal,
      );
      const id = started.output.split(': ')[1];
      controller.abort();
      finish?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runs, timing === 'before-start' ? 0 : 1);
      assert.equal(f.store.isLeased(f.session.id), false);
      restored = new RuntimeServices(f.store, executor, async () => {});
      for (const runtime of [services, restored]) {
        const status = JSON.parse(
          (
            await runtime.execute(
              { id: 'status', name: 'background_status', input: { id } },
              f.session,
              new AbortController().signal,
            )
          ).output,
        );
        assert.equal(status.status, 'cancelled');
      }
      assert.equal(
        f.store.events(f.session.id).filter((event) => event.type === 'background_finished').length,
        1,
      );
    } finally {
      finish?.();
      await restored?.close();
      await services.close();
      f.close();
    }
  });
}

for (const status of ['completed', 'failed'] as const) {
  test(`a late child callback preserves an existing ${status} parent receipt`, async () => {
    const f = fixture();
    const services = new RuntimeServices(
      f.store,
      {
        async execute() {
          throw new Error('unused');
        },
        async close() {},
      },
      async (child) => {
        f.store.append(child.id, 'assistant', { text: 'late callback answer', calls: [] });
        f.store.append(child.id, 'turn_completed', {});
        f.store.append(f.session.id, 'subagent_finished', {
          childId: child.id,
          status,
          answer: 'durable original result',
          ...(status === 'failed' ? { error: 'recorded cancellation' } : {}),
        });
      },
    );
    try {
      const started = await services.execute(
        { id: 'spawn', name: 'spawn_subagent', input: { prompt: 'inspect' } },
        f.session,
        new AbortController().signal,
      );
      const id = started.output.split(': ')[1];
      await services.waitForSubagents(f.session.id, new AbortController().signal);
      const receipts = f.store
        .events(f.session.id)
        .filter((event) => event.type === 'subagent_finished');
      assert.equal(receipts.length, 1);
      const result = JSON.parse(
        (
          await services.execute(
            { id: 'status', name: 'subagent_status', input: { id } },
            f.session,
            new AbortController().signal,
          )
        ).output,
      );
      assert.equal(result.status, status);
      assert.equal(result.answer, 'durable original result');
      if (status === 'failed') assert.equal(result.error, 'recorded cancellation');
    } finally {
      await services.close();
      f.close();
    }
  });
}

for (const kind of ['turn_started', 'before_tool', 'after_tool', 'turn_finished'] as const) {
  test(`hook transport errors are recorded and propagated at ${kind}`, async () => {
    const f = fixture();
    let executions = 0;
    const services = new RuntimeServices(
      f.store,
      {
        async execute() {
          executions++;
          throw new Error('hook worker disconnected');
        },
        async close() {},
      },
      async () => {},
    );
    try {
      await assert.rejects(
        services.runHooks(kind, f.session, new AbortController().signal, [
          { name: 'first', event: kind, command: 'verify', enabled: true },
          { name: 'second', event: kind, command: 'do-not-run', enabled: true },
        ]),
        /hook worker disconnected/,
      );
      assert.equal(executions, 1);
      const hooks = f.store.events(f.session.id).filter((event) => event.type === 'hook_finished');
      assert.equal(hooks.length, 1);
      assert.equal(hooks[0].payload.event, kind);
      assert.equal(hooks[0].payload.name, 'first');
      assert.equal(hooks[0].payload.isError, true);
      assert.equal(hooks[0].payload.executionUnknown, true);
      assert.match(String(hooks[0].payload.output), /hook worker disconnected/);
    } finally {
      await services.close();
      f.close();
    }
  });
}

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
    f.store.append(child.id, 'turn_completed', {});
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
    assert.equal(JSON.parse(childStatus.output).status, 'completed');
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

test('spawn_subagent rejects a Bruin worktree belonging to a different Git repository', async () => {
  const f = fixture();
  const repoA = path.join(f.dir, 'repo-a');
  const repoB = path.join(f.dir, 'repo-b');
  for (const repo of [repoA, repoB]) {
    fs.mkdirSync(repo);
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), path.basename(repo));
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  }
  const sessionA = f.store.createSession(fs.realpathSync(repoA), f.session.profile);
  const sessionB = f.store.createSession(fs.realpathSync(repoB), f.session.profile);
  const executor: ToolExecutor = {
    async execute() {
      return { output: 'done', isError: false };
    },
    async close() {},
  };
  const services = new RuntimeServices(f.store, executor, async () => {});
  try {
    const created = await services.execute(
      { id: 'wt-b', name: 'create_worktree', input: { name: 'other-repo-wt' } },
      sessionB,
      new AbortController().signal,
    );
    assert.equal(created.isError, false, created.output);
    const rejected = await services.execute(
      {
        id: 'spawn-cross-repo',
        name: 'spawn_subagent',
        input: { prompt: 'inspect', worktree: created.output },
      },
      sessionA,
      new AbortController().signal,
    );
    assert.equal(rejected.isError, true);
    assert.match(rejected.output, /不属于当前仓库/);
  } finally {
    await services.close();
    f.close();
  }
});

test('McpManager reconnects after a stdio server exits and does not deadlock on heavy stderr', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-mcp-reconnect-'));
  const marker = path.join(dir, 'starts.txt');
  const script = path.join(dir, 'server.mjs');
  fs.writeFileSync(
    script,
    `
import fs from 'node:fs';
import readline from 'node:readline';
fs.appendFileSync(${JSON.stringify(marker)}, 'start\\n');
// Write > 128 KB to stderr to ensure unconsumed stderr never deadlocks the pipe.
process.stderr.write('x'.repeat(150_000) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'noisy', version: '1.0.0' },
      },
    }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: [{ name: 'crash', description: 'exit now', inputSchema: { type: 'object' } }] },
    }) + '\\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'exiting' }] },
    }) + '\\n');
    setTimeout(() => process.exit(0), 20);
  }
});
`,
  );
  const manager = new McpManager();
  const server = mcpServerSchema.parse({
    name: 'noisy',
    transport: 'stdio',
    command: process.execPath,
    args: [script],
    envNames: [],
  });
  try {
    const tools = await manager.listTools(server, dir);
    assert.equal(tools[0]?.name, 'crash');
    const call = await manager.callTool(server, 'crash', {}, dir);
    assert.equal(call.isError, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterReconnect = await manager.listTools(server, dir);
    assert.equal(afterReconnect[0]?.name, 'crash');
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 2);
  } finally {
    await manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
