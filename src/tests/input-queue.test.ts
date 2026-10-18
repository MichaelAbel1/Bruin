import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteEventStore } from '../storage/event-store.js';
import { enqueueInput, consumeInputs, pendingInputs } from '../core/input-queue.js';
import { AgentRunner } from '../core/agent.js';
import { importAttachments } from '../core/attachments.js';

test('queued input survives reopen; its user event acknowledges it without a second write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-inbox-'));
  const file = path.join(dir, 'sessions.sqlite');
  let store = new SqliteEventStore(file);
  try {
    const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
    enqueueInput(store, session.id, {
      id: 'next',
      mode: 'follow-up',
      text: 'then test',
      attachments: [],
    });
    assert.deepEqual(consumeInputs(store, session.id, false), []);
    store.close();
    store = new SqliteEventStore(file);
    assert.equal(pendingInputs(store.events(session.id)).length, 1);
    assert.deepEqual(consumeInputs(store, session.id, true), ['next']);
    store.close();
    store = new SqliteEventStore(file);
    assert.deepEqual(consumeInputs(store, session.id, true), []);
    assert.equal(store.events(session.id).filter((e) => e.type === 'user').length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('steering waits for tool completion and follow-up waits for an answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-steer-'));
  const previousHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'source');
    const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
    let calls = 0;
    let toolsFinished = false;
    const runner = new AgentRunner(
      store,
      {
        async complete(_profile, prompt) {
          const text = JSON.stringify(prompt);
          calls++;
          if (calls === 1) {
            enqueueInput(store, session.id, {
              id: 'steer',
              mode: 'steer',
              text: 'keep compatibility',
              attachments: [],
            });
            enqueueInput(store, session.id, {
              id: 'later',
              mode: 'follow-up',
              text: 'then explain tests',
              attachments: [],
            });
            return {
              text: '',
              calls: [{ id: 'read', name: 'read_file', input: { path: 'a.txt' } }],
            };
          }
          assert.equal(toolsFinished, true);
          assert.match(text, /keep compatibility/);
          if (calls === 2) assert.doesNotMatch(text, /then explain tests/);
          else assert.match(text, /then explain tests/);
          return { text: 'answer', calls: [] };
        },
      },
      {
        async execute() {
          toolsFinished = true;
          return { output: 'source', isError: false };
        },
        async close() {},
      },
      {
        text() {},
        notice() {},
        async approve() {
          throw new Error('no approval expected');
        },
      },
    );
    await runner.run(session, 'inspect');
    assert.equal(calls, 3);
    assert.equal(pendingInputs(store.events(session.id)).length, 0);
    assert.equal(store.events(session.id).filter((e) => e.type === 'turn_completed').length, 1);
    assert.deepEqual(
      store
        .events(session.id)
        .filter((e) => e.type === 'user')
        .map((e) => e.payload.text),
      ['inspect', 'keep compatibility', 'then explain tests'],
    );
  } finally {
    store.close();
    if (previousHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a follow-up at the step limit is durable and pauses without claiming completion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-inbox-limit-'));
  const previousHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
    const runner = new AgentRunner(
      store,
      {
        async complete() {
          enqueueInput(store, session.id, {
            id: 'later',
            mode: 'follow-up',
            text: 'verify',
            attachments: [],
          });
          return { text: 'answer', calls: [] };
        },
      },
      {
        async execute() {
          throw new Error('unexpected tool');
        },
        async close() {},
      },
      {
        text() {},
        notice() {},
        async approve() {
          return false;
        },
      },
    );
    await runner.run(session, 'inspect', undefined, [], undefined, { maxModelCalls: 1 });
    const events = store.events(session.id);
    assert.equal(events.at(-1)?.type, 'turn_paused');
    assert.ok(events.some((e) => e.type === 'user' && e.payload.queuedInputId === 'later'));
    assert.ok(!events.some((e) => e.type === 'turn_completed'));
  } finally {
    store.close();
    if (previousHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const interrupted of [false, true]) {
  test(`queued images reach the model individually, including after interruption=${interrupted}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-queued-images-'));
    const previousHome = process.env.BRUIN_HOME;
    process.env.BRUIN_HOME = path.join(dir, 'home');
    const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
    try {
      const session = store.createSession(dir, {
        alias: 'test',
        provider: 'openai',
        model: 'mock',
      });
      const file = path.join(dir, 'pixel.png');
      fs.writeFileSync(
        file,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      const first = importAttachments(session.id, [file]);
      const second = importAttachments(session.id, [file]);
      let calls = 0;
      const runner = new AgentRunner(
        store,
        {
          async complete(_profile, prompt) {
            calls++;
            if (calls === 1) {
              enqueueInput(store, session.id, {
                id: 'first',
                mode: 'steer',
                text: 'FIRST_IMAGE',
                attachments: first,
              });
              enqueueInput(store, session.id, {
                id: 'second',
                mode: 'steer',
                text: 'SECOND_IMAGE',
                attachments: second,
              });
              return { text: 'initial answer', calls: [] };
            }
            const users = prompt.filter((m) => m.role === 'user');
            const latest = users.at(-1)!;
            const parts = Array.isArray(latest.content) ? latest.content : [];
            assert.equal(parts.filter((part) => part.type === 'image').length, 1);
            if (calls === 2 || (interrupted && calls === 3)) {
              assert.match(JSON.stringify(latest), /FIRST_IMAGE/);
              assert.doesNotMatch(JSON.stringify(prompt), /SECOND_IMAGE/);
              if (interrupted && calls === 2) throw new Error('mock request interrupted');
            } else assert.match(JSON.stringify(latest), /SECOND_IMAGE/);
            return { text: 'image received', calls: [] };
          },
        },
        {
          async execute() {
            throw new Error('unexpected tool');
          },
          async close() {},
        },
        {
          text() {},
          notice() {},
          async approve() {
            return false;
          },
        },
      );
      if (interrupted) {
        await assert.rejects(runner.run(session, 'initial request'), /mock request interrupted/);
        assert.deepEqual(
          pendingInputs(store.events(session.id)).map((input) => input.id),
          ['second'],
        );
        await runner.run(session);
      } else await runner.run(session, 'initial request');
      assert.equal(calls, interrupted ? 4 : 3);
      assert.equal(pendingInputs(store.events(session.id)).length, 0);
      assert.equal(
        store.events(session.id).filter((e) => e.type === 'user' && e.payload.queuedInputId).length,
        2,
      );
    } finally {
      store.close();
      if (previousHome === undefined) delete process.env.BRUIN_HOME;
      else process.env.BRUIN_HOME = previousHome;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('pause reports do not acknowledge admitted input or drain the next message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-queue-pause-'));
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
    for (const id of ['one', 'two'])
      enqueueInput(store, session.id, { id, mode: 'steer', text: id, attachments: [] });
    assert.deepEqual(consumeInputs(store, session.id, false), ['one']);
    store.append(session.id, 'assistant', { text: 'paused', calls: [] });
    store.append(session.id, 'turn_paused', { report: 'paused' });
    assert.deepEqual(consumeInputs(store, session.id, false), []);
    store.append(session.id, 'assistant', { text: 'actual model answer', calls: [] });
    assert.deepEqual(consumeInputs(store, session.id, true), ['two']);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
