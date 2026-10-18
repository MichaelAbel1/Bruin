import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../core/agent.js';
import { RuntimeServices } from '../runtime/services.js';
import { SqliteEventStore } from '../storage/event-store.js';

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
