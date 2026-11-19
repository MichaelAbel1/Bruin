import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../core/agent.js';
import { RuntimeServices } from '../runtime/services.js';
import { SqliteEventStore } from '../storage/event-store.js';
import { enqueueInput, pendingInputs } from '../core/input-queue.js';
import { turnState } from '../core/turn-state.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitingFixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-child-steering-'));
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
  const controller = new AbortController();
  const release = deferred();
  const entered = deferred();
  const executor = {
    async execute() {
      throw new Error('unused');
    },
    async close() {},
  };
  const services = new RuntimeServices(store, executor, async (child, _prompt, signal) => {
    const stop = () => release.resolve();
    signal.addEventListener('abort', stop, { once: true });
    try {
      await release.promise;
      store.append(child.id, 'assistant', { text: 'child finding', calls: [] });
      store.append(child.id, 'turn_completed', {});
    } finally {
      signal.removeEventListener('abort', stop);
    }
  });
  const wait = services.waitForSubagents.bind(services);
  t.mock.method(services, 'waitForSubagents', (...args: Parameters<typeof wait>) => {
    const pending = wait(...args);
    entered.resolve();
    return pending;
  });
  t.after(async () => {
    controller.abort();
    release.resolve();
    await services.close();
    store.close();
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, session, controller, services, executor, entered, release };
}

test(
  'exhausted model calls pause without waiting indefinitely for a child and resume its recorded result',
  { timeout: 5000 },
  async (t) => {
    const f = waitingFixture(t);
    let calls = 0;
    const runner = new AgentRunner(
      f.store,
      {
        async complete(_profile, prompt) {
          if (++calls === 1)
            return {
              text: '',
              calls: [{ id: 'spawn', name: 'spawn_subagent', input: { prompt: 'research' } }],
            };
          if (calls > 2) assert.match(String(prompt[0].content), /child finding/);
          return { text: calls === 2 ? 'Waiting for research.' : 'Research summary.', calls: [] };
        },
      },
      f.executor,
      {
        text() {},
        notice() {},
        async approve() {
          return true;
        },
      },
      f.services,
    );
    const running = runner.run(f.session, 'Investigate', f.controller.signal, [], undefined, {
      maxModelCalls: 2,
    });
    void running.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await f.entered.promise;
      await Promise.race([
        running,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('exhausted run kept waiting for a child')),
            1000,
          );
        }),
      ]);
      assert.equal(turnState(f.store.events(f.session.id)), 'paused');
      assert.equal(calls, 2);
      assert.equal(f.store.isLeased(f.session.id), true);
      assert.equal(
        f.store.events(f.session.id).some((event) => event.type === 'turn_completed'),
        false,
      );
      f.release.resolve();
      await f.services.waitForSubagents(f.session.id, f.controller.signal);
      assert.equal(f.store.events(f.session.id).at(-1)?.type, 'subagent_finished');
      assert.equal(turnState(f.store.events(f.session.id)), 'paused');
      await runner.run(f.session, undefined, f.controller.signal);
      assert.equal(calls, 3);
      assert.equal(turnState(f.store.events(f.session.id)), 'completed');
      assert.equal(
        f.store.events(f.session.id).filter((event) => event.type === 'subagent_started').length,
        1,
      );
      assert.equal(f.store.events(f.session.id).filter((event) => event.type === 'user').length, 1);
    } finally {
      clearTimeout(timer);
      f.controller.abort();
      f.release.resolve();
      await Promise.allSettled([running]);
    }
  },
);

for (const timing of ['before-wait', 'during-wait'] as const) {
  for (const exhausted of [false, true]) {
    test(
      `steering interrupts a child wait: ${timing}, budget exhausted=${exhausted}`,
      { timeout: 5000 },
      async (t) => {
        const f = waitingFixture(t);
        const observed = deferred();
        const queue = () =>
          enqueueInput(f.store, f.session.id, {
            id: 'steer',
            mode: 'steer',
            text: 'STOP_RESEARCH',
            attachments: [],
          });
        let calls = 0;
        let summarizedCancellation = false;
        const runner = new AgentRunner(
          f.store,
          {
            async complete(_profile, prompt) {
              if (++calls === 1)
                return {
                  text: '',
                  calls: [{ id: 'spawn', name: 'spawn_subagent', input: { prompt: 'research' } }],
                };
              if (calls === 2) {
                if (timing === 'before-wait') queue();
                return { text: 'Waiting.', calls: [] };
              }
              assert.match(
                JSON.stringify(prompt.filter((message) => message.role === 'user').at(-1)),
                /STOP_RESEARCH/,
              );
              if (calls === 3) {
                assert.equal(
                  f.store.events(f.session.id).some((event) => event.type === 'subagent_finished'),
                  false,
                );
                observed.resolve();
                const started = f.store
                  .events(f.session.id)
                  .find((event) => event.type === 'subagent_started')!;
                return {
                  text: '',
                  calls: [
                    { id: 'stop', name: 'cancel_subagent', input: { id: started.payload.childId } },
                  ],
                };
              }
              summarizedCancellation ||= /Subagent results.*"status":"failed"/s.test(
                String(prompt[0]?.content),
              );
              return { text: 'Stopped research.', calls: [] };
            },
          },
          f.executor,
          {
            text() {},
            notice() {},
            async approve() {
              return true;
            },
          },
          f.services,
        );
        const running = runner.run(
          f.session,
          'Investigate',
          f.controller.signal,
          [],
          undefined,
          exhausted ? { maxModelCalls: 2 } : {},
        );
        void running.catch(() => {});
        await f.entered.promise;
        if (timing === 'during-wait') queue();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exhausted ? running : observed.promise,
            new Promise<void>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('steering was blocked by the child wait')),
                1000,
              );
            }),
          ]);
          if (exhausted) {
            assert.equal(f.store.events(f.session.id).at(-1)?.type, 'turn_paused');
            assert.equal(
              f.store.events(f.session.id).some((event) => event.type === 'turn_completed'),
              false,
            );
            assert.equal(calls, 2);
            await runner.run(f.session, undefined, f.controller.signal);
          } else await running;
          assert.ok(calls >= 4);
          assert.equal(summarizedCancellation, true);
          const events = f.store.events(f.session.id);
          assert.equal(
            events.filter(
              (event) => event.type === 'user' && event.payload.queuedInputId === 'steer',
            ).length,
            1,
          );
          assert.equal(events.filter((event) => event.type === 'turn_completed').length, 1);
          assert.deepEqual(pendingInputs(events), []);
        } finally {
          clearTimeout(timer);
          f.controller.abort();
          await Promise.allSettled([running]);
        }
      },
    );
  }
}

test('follow-up messages wait for child results and their summary', async (t) => {
  const f = waitingFixture(t);
  let calls = 0;
  const runner = new AgentRunner(
    f.store,
    {
      async complete(_profile, prompt) {
        if (++calls === 1)
          return {
            text: '',
            calls: [{ id: 'spawn', name: 'spawn_subagent', input: { prompt: 'research' } }],
          };
        if (calls >= 3) {
          assert.match(JSON.stringify(prompt), /child finding/);
          const latest = JSON.stringify(prompt.filter((message) => message.role === 'user').at(-1));
          if (calls === 3) assert.doesNotMatch(latest, /FOLLOW_UP/);
          else assert.match(latest, /FOLLOW_UP/);
        }
        return { text: 'answer', calls: [] };
      },
    },
    f.executor,
    {
      text() {},
      notice() {},
      async approve() {
        return true;
      },
    },
    f.services,
  );
  const running = runner.run(f.session, 'Investigate', f.controller.signal);
  void running.catch(() => {});
  try {
    await f.entered.promise;
    enqueueInput(f.store, f.session.id, {
      id: 'later',
      mode: 'follow-up',
      text: 'FOLLOW_UP',
      attachments: [],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    f.release.resolve();
    await running;
    assert.equal(calls, 4);
  } finally {
    f.controller.abort();
    await Promise.allSettled([running]);
  }
});

test('child waits only wake for committed steering in their own session', async (t) => {
  const f = waitingFixture(t);
  await f.services.execute(
    { id: 'spawn', name: 'spawn_subagent', input: { prompt: 'research' } },
    f.session,
    f.controller.signal,
  );
  let returned = false;
  const waiting = f.services.waitForSubagents(f.session.id, f.controller.signal).then(() => {
    returned = true;
  });
  const other = f.store.createSession(f.session.workspace, f.session.profile);
  enqueueInput(f.store, other.id, {
    id: 'other',
    mode: 'steer',
    text: 'other session',
    attachments: [],
  });
  enqueueInput(f.store, f.session.id, {
    id: 'later',
    mode: 'follow-up',
    text: 'follow-up',
    attachments: [],
  });
  const append = f.store.append.bind(f.store);
  const failure = t.mock.method(f.store, 'append', (...args: Parameters<typeof append>) => {
    if (args[1] === 'input_queued') throw new Error('queue write failed');
    return append(...args);
  });
  assert.throws(
    () =>
      enqueueInput(f.store, f.session.id, {
        id: 'failed',
        mode: 'steer',
        text: 'not stored',
        attachments: [],
      }),
    /queue write failed/,
  );
  failure.mock.restore();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  enqueueInput(f.store, f.session.id, {
    id: 'correct',
    mode: 'steer',
    text: 'adjust now',
    attachments: [],
  });
  await waiting;
  assert.deepEqual(
    pendingInputs(f.store.events(f.session.id)).map((input) => input.id),
    ['later', 'correct'],
  );
});

for (const outcome of ['completed', 'failed', 'cancelled', 'budget'] as const) {
  test(`subagent delivery: ${outcome}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-child-delivery-'));
    const oldHome = process.env.BRUIN_HOME;
    process.env.BRUIN_HOME = path.join(dir, 'home');
    const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
    const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
    const controller = new AbortController();
    let release!: () => void;
    const executor = {
      async execute() {
        throw new Error('unused');
      },
      async close() {},
    };
    const services = new RuntimeServices(store, executor, async (child, _prompt, signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (outcome === 'failed') throw new Error('research unavailable');
      store.append(child.id, 'assistant', { text: 'RESEARCH_FINDING', calls: [] });
      store.append(child.id, 'turn_completed', {});
    });
    let calls = 0;
    const runner = new AgentRunner(
      store,
      {
        async complete(_profile, messages) {
          calls++;
          if (calls === 1)
            return {
              text: '',
              calls: [
                { id: 'spawn', name: 'spawn_subagent' as const, input: { prompt: 'research' } },
              ],
            };
          if (calls === 2) {
            if (outcome === 'cancelled') controller.abort();
            else if (outcome !== 'budget') setTimeout(release, 10);
          } else {
            assert.match(JSON.stringify(messages), /untrusted research data/);
            assert.match(
              JSON.stringify(messages),
              outcome === 'failed' ? /research unavailable/ : /RESEARCH_FINDING/,
            );
          }
          return { text: calls === 2 ? 'Waiting for research.' : 'Research summary.', calls: [] };
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
    try {
      const running = runner.run(
        session,
        'Investigate',
        controller.signal,
        [],
        undefined,
        outcome === 'budget' ? { maxDurationMs: 100 } : {},
      );
      if (outcome === 'cancelled') await assert.rejects(running, /已取消/);
      else await running;
      const events = store.events(session.id);
      if (outcome === 'completed' || outcome === 'failed') {
        assert.equal(calls, 3);
        assert.equal(events.filter((event) => event.type === 'turn_completed').length, 1);
        assert.equal(events.filter((event) => event.type === 'user').length, 1);
        const result = events.find((event) => event.type === 'subagent_finished')!;
        assert.equal(result.payload.status, outcome);
        if (outcome === 'completed') assert.equal(result.payload.answer, 'RESEARCH_FINDING');
      } else {
        assert.equal(
          events.some((event) => event.type === 'turn_completed'),
          false,
        );
        if (outcome === 'budget') assert.equal(events.at(-1)?.type, 'turn_paused');
      }
    } finally {
      await services.close();
      store.close();
      if (oldHome === undefined) delete process.env.BRUIN_HOME;
      else process.env.BRUIN_HOME = oldHome;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
