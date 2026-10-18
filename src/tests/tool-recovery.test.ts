import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../core/agent.js';
import { SqliteEventStore } from '../storage/event-store.js';

test('recovery separates unstarted, interrupted reads and uncertain side effects without replay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-recovery-policy-'));
  const file = path.join(dir, 'db.sqlite');
  let store = new SqliteEventStore(file);
  try {
    const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
    const cases = [
      {
        id: 'unstarted-write',
        name: 'write_file',
        started: false,
        recovery: 'manual',
        expected: 'tool_denied',
      },
      {
        id: 'safe-read',
        name: 'read_file',
        started: true,
        recovery: 'safe',
        expected: 'tool_finished',
      },
      {
        id: 'hooked-read',
        name: 'read_file',
        started: true,
        recovery: 'manual',
        expected: 'tool_unknown',
      },
      {
        id: 'legacy-read',
        name: 'read_file',
        started: true,
        recovery: undefined,
        expected: 'tool_unknown',
      },
      {
        id: 'unsafe-write',
        name: 'write_file',
        started: true,
        recovery: 'safe',
        expected: 'tool_unknown',
      },
      { id: 'shell', name: 'shell', started: true, recovery: 'manual', expected: 'tool_unknown' },
    ];
    for (const item of cases) {
      store.append(session.id, 'assistant', {
        calls: [{ id: item.id, name: item.name, input: {} }],
      });
      if (item.started)
        store.append(session.id, 'tool_started', {
          callId: item.id,
          name: item.name,
          recovery: item.recovery,
        });
    }
    store.close();
    store = new SqliteEventStore(file);
    const runner = new AgentRunner(
      store,
      {
        async complete() {
          throw new Error('must not call model');
        },
      },
      {
        async execute() {
          throw new Error('must never replay');
        },
        async close() {},
      },
      {
        text() {},
        notice() {},
        async approve() {
          throw new Error('must not approve');
        },
      },
    );
    assert.equal(runner.recover(session), 4);
    assert.equal(runner.recover(session), 0);
    for (const item of cases) {
      const results = store
        .events(session.id)
        .filter((event) => event.payload.callId === item.id && event.type !== 'tool_started');
      assert.equal(results.length, 1);
      assert.equal(results[0].type, item.expected);
      if (item.expected === 'tool_finished') assert.equal(results[0].payload.isError, true);
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
