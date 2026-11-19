import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../core/agent.js';
import { SqliteEventStore } from '../storage/event-store.js';
import type { ModelGateway } from '../providers/gateway.js';
import { RuntimeServices } from '../runtime/services.js';

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-child-recovery-'));
  const previous = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const file = path.join(dir, 'home', 'db.sqlite');
  const f = { store: new SqliteEventStore(file) };
  const parent = f.store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
  const child = f.store.createSession(dir, parent.profile);
  f.store.append(parent.id, 'subagent_started', {
    childId: child.id,
    prompt: 'investigate',
    workspace: dir,
    mode: 'worktree',
    baseCommit: 'original-base',
  });
  fs.writeFileSync(path.join(dir, 'retained.txt'), 'existing proposal');
  t.after(() => {
    f.store.close();
    if (previous === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const notices: string[] = [];
  return {
    get store() {
      return f.store;
    },
    dir,
    parent,
    child,
    notices,
    reopen() {
      f.store.close();
      f.store = new SqliteEventStore(file);
    },
    runner(
      gateway: ModelGateway = {
        async complete() {
          throw new Error('recovery must not invoke a model');
        },
      },
    ) {
      return new AgentRunner(
        f.store,
        gateway,
        {
          async execute() {
            throw new Error('recovery must not replay tools');
          },
          async close() {},
        },
        {
          text() {},
          notice(message) {
            notices.push(message);
          },
          async approve() {
            throw new Error('no approval expected');
          },
        },
      );
    },
  };
}

test('a parent receives the newest child results within its prompt budget', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 8; index++) {
    f.store.append(f.parent.id, 'subagent_finished', {
      childId: `historical-${index}`,
      status: 'completed',
      answer: '早期结果"\\\n'.repeat(500),
    });
  }
  f.store.append(f.parent.id, 'turn_completed', {});
  for (const [childId, status, finding] of [
    [f.child.id, 'completed', 'LATEST_IMPLEMENTATION'],
    ['recent-failure', 'failed', 'LATEST_FAILURE'],
  ]) {
    f.store.append(f.parent.id, 'subagent_finished', {
      childId,
      status,
      answer: (status === 'completed' ? finding : '') + '中文😀"\\\n'.repeat(1800),
      ...(status === 'failed' ? { error: finding + '异常"\\\n'.repeat(1500) } : {}),
    });
  }
  f.reopen();
  const runner = f.runner({
    inputOverheadTokens: () => 1500,
    async complete(_profile, prompt) {
      const system = String(prompt[0].content);
      const context = system.split('Subagent results')[1]?.trim();
      assert.ok(context);
      const data = context.slice(context.indexOf('\n') + 1).split('\n')[0];
      const records = JSON.parse(data) as Array<{
        childId: string;
        status: string;
        answer: string;
        error?: string;
        truncated?: boolean;
      }>;
      assert.equal(records[0]?.childId, 'recent-failure');
      assert.equal(records[0]?.status, 'failed');
      assert.match(records[0]?.error ?? '', /LATEST_FAILURE/);
      const completed = records.find((record) => record.childId === f.child.id);
      assert.match(completed?.answer ?? '', /LATEST_IMPLEMENTATION/);
      assert.equal(completed?.truncated, true);
      return { text: 'both results available', calls: [] };
    },
  });
  await runner.run(
    { ...f.parent, profile: { ...f.parent.profile, contextWindowTokens: 8192 } },
    'summarize both current results',
  );
});

test('failed child status uses the original attempt after an independent continuation', async (t) => {
  const f = fixture(t);
  f.store.append(f.child.id, 'user', { text: 'investigate' });
  f.store.append(f.child.id, 'assistant', { text: 'original partial answer', calls: [] });
  f.store.append(f.child.id, 'assistant', {
    text: 'budget report',
    calls: [],
    synthetic: 'pause_report',
  });
  f.store.append(f.child.id, 'turn_paused', { reason: 'step_limit' });
  f.store.append(f.parent.id, 'subagent_finished', {
    childId: f.child.id,
    status: 'failed',
    error: 'budget exhausted',
  });
  f.store.append(f.child.id, 'user', { text: 'something else' });
  f.store.append(f.child.id, 'assistant', { text: 'unrelated answer', calls: [] });
  f.store.append(f.child.id, 'turn_completed', {});
  f.reopen();
  const services = new RuntimeServices(
    f.store,
    {
      async execute() {
        throw new Error('unexpected execution');
      },
      async close() {},
    },
    async () => {},
  );
  try {
    const result = await services.execute(
      { id: 'status', name: 'subagent_status', input: { id: f.child.id } },
      f.parent,
      new AbortController().signal,
    );
    assert.equal(result.isError, false);
    const status = JSON.parse(result.output);
    assert.equal(status.answer, 'original partial answer');
    assert.equal(status.status, 'failed');
    assert.equal(status.error, 'budget exhausted');
  } finally {
    await services.close();
  }
});

for (const source of ['model', 'desktop'] as const) {
  test(`a durable delegation receipt resolves only the exact interrupted ${source} spawn call`, (t) => {
    const f = fixture(t);
    const call = { id: 'reused', name: 'spawn_subagent', input: { prompt: 'investigate' } };
    const recordRequest = () => {
      if (source === 'model') f.store.append(f.parent.id, 'assistant', { text: '', calls: [call] });
      else
        f.store.append(f.parent.id, 'tool_requested', {
          callId: call.id,
          name: call.name,
          input: call.input,
          source: 'desktop',
        });
    };
    recordRequest();
    const started = f.store.append(f.parent.id, 'tool_started', {
      callId: call.id,
      name: call.name,
      recovery: 'manual',
    });
    f.store.append(f.parent.id, 'subagent_started', {
      childId: f.child.id,
      prompt: call.input.prompt,
      workspace: f.dir,
      toolStartedSeq: started.seq,
    });
    f.store.append(f.child.id, 'user', { text: call.input.prompt });
    f.store.append(f.child.id, 'assistant', { text: 'the child finished', calls: [] });
    f.store.append(f.child.id, 'turn_completed', {});
    f.reopen();

    const runner = f.runner();
    assert.equal(runner.recover(f.parent), 0);
    const events = f.store.events(f.parent.id);
    const toolResult = events.find((event) => event.type === 'tool_finished');
    assert.equal(toolResult?.payload.callId, call.id);
    assert.equal(toolResult?.payload.isError, false);
    assert.ok(String(toolResult?.payload.output).includes(f.child.id));
    assert.match(String(toolResult?.payload.output), /启动记录/);
    assert.equal(
      events.find((event) => event.type === 'subagent_finished')?.payload.answer,
      'the child finished',
    );
    assert.equal(runner.recover(f.parent), 0);
    assert.deepEqual(f.store.events(f.parent.id), events);

    recordRequest();
    f.store.append(f.parent.id, 'tool_started', { callId: call.id, name: call.name });
    assert.equal(runner.recover(f.parent), 1);
    assert.equal(f.store.events(f.parent.id).at(-1)?.type, 'tool_unknown');
  });
}

for (const status of ['completed', 'paused'] as const) {
  test(`recovery delivers a recorded child ${status} result after a lost parent receipt`, async (t) => {
    const f = fixture(t);
    f.store.append(f.child.id, 'user', { text: 'investigate' });
    f.store.append(f.child.id, 'assistant', { text: 'original finding', calls: [] });
    if (status === 'paused')
      f.store.append(f.child.id, 'assistant', {
        text: 'budget report',
        calls: [],
        synthetic: 'pause_report',
      });
    const terminal = f.store.append(
      f.child.id,
      status === 'completed' ? 'turn_completed' : 'turn_paused',
      { reason: 'step_limit' },
    );
    // Independent later conversation must not replace the original delegation.
    f.store.append(f.child.id, 'user', { text: 'a different task' });
    f.store.append(f.child.id, 'assistant', { text: 'unrelated answer', calls: [] });
    f.store.append(f.child.id, 'turn_completed', {});
    const childBefore = f.store.events(f.child.id);
    f.reopen();
    const runner = f.runner({
      async complete(_profile, prompt) {
        assert.match(String(prompt[0].content), /original finding/);
        assert.doesNotMatch(String(prompt[0].content), /unrelated answer|budget report/);
        return { text: 'recovered summary', calls: [] };
      },
    });
    assert.equal(runner.recover(f.parent), 0);
    assert.equal(runner.recover(f.parent), 0);
    const results = f.store
      .events(f.parent.id)
      .filter((event) => event.type === 'subagent_finished');
    assert.equal(results.length, 1);
    assert.equal(results[0].payload.status, status === 'completed' ? 'completed' : 'failed');
    assert.equal(results[0].payload.answer, 'original finding');
    assert.equal(results[0].payload.recovered, true);
    assert.equal(results[0].payload.throughSeq, terminal.seq);
    assert.equal(results[0].payload.workspace, f.dir);
    assert.equal(results[0].payload.baseCommit, 'original-base');
    if (status === 'paused') assert.match(String(results[0].payload.error), /尚未完成/);
    assert.deepEqual(f.store.events(f.child.id), childBefore);
    await runner.run(f.parent, 'summarize the recovered delegation');
    assert.equal(fs.readFileSync(path.join(f.dir, 'retained.txt'), 'utf8'), 'existing proposal');
  });
}

for (const evidence of [
  'no-terminal',
  'later-turn',
  'wrong-prompt',
  'no-user',
  'deleted',
] as const) {
  test(`ambiguous child recovery remains unresolved: ${evidence}`, async (t) => {
    const f = fixture(t);
    if (evidence !== 'no-user')
      f.store.append(f.child.id, 'user', {
        text: evidence === 'wrong-prompt' ? 'different request' : 'investigate',
      });
    f.store.append(f.child.id, 'assistant', { text: 'partial research', calls: [] });
    if (evidence === 'later-turn')
      f.store.append(f.child.id, 'user', { text: 'unrelated continuation' });
    if (evidence !== 'no-terminal') f.store.append(f.child.id, 'turn_completed', {});
    if (evidence === 'deleted') f.store.deleteSession(f.child.id);
    f.reopen();
    const runner = f.runner({
      async complete(_profile, prompt) {
        const system = String(prompt[0].content);
        assert.match(system, /Delegated tasks without a recorded result/);
        assert.ok(system.includes(f.child.id));
        assert.match(system, /never assume success/);
        return { text: 'A delegated task still needs inspection.', calls: [] };
      },
    });
    assert.equal(runner.recover(f.parent), 0);
    assert.equal(
      f.store.events(f.parent.id).some((event) => event.type === 'subagent_finished'),
      false,
    );
    await runner.run(f.parent, 'continue');
    assert.ok(f.notices.some((message) => /1 个子任务.*未记录结果/.test(message)));
    assert.equal(fs.readFileSync(path.join(f.dir, 'retained.txt'), 'utf8'), 'existing proposal');
  });
}

test('child results are not recovered while leased and existing parent receipts are preserved', (t) => {
  const f = fixture(t);
  f.store.append(f.child.id, 'user', { text: 'investigate' });
  f.store.append(f.child.id, 'assistant', { text: 'finding', calls: [] });
  f.store.append(f.child.id, 'turn_completed', {});
  f.store.acquireLease(f.child.id, 'still-settling', 30_000);
  f.reopen();
  const runner = f.runner();
  runner.recover(f.parent);
  assert.equal(
    f.store.events(f.parent.id).some((event) => event.type === 'subagent_finished'),
    false,
  );
  f.store.releaseLease(f.child.id, 'still-settling');
  f.store.append(f.parent.id, 'subagent_finished', {
    childId: f.child.id,
    status: 'failed',
    error: 'known cancellation',
  });
  runner.recover(f.parent);
  const results = f.store.events(f.parent.id).filter((event) => event.type === 'subagent_finished');
  assert.equal(results.length, 1);
  assert.equal(results[0].payload.status, 'failed');
  assert.equal(results[0].payload.error, 'known cancellation');
});
