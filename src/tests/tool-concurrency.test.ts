import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../core/agent.js';
import { SqliteEventStore } from '../storage/event-store.js';
import type { ToolCall, ToolResult } from '../core/types.js';
import { RuntimeServices } from '../runtime/services.js';
import { loadConfig, saveConfig } from '../config.js';

test('enabled tool hooks keep otherwise parallel reads serial', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-hook-serial-'));
  const previousHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  let active = 0;
  let maximum = 0;
  let beforeHooks = 0;
  const executor = {
    async execute() {
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return { output: 'source', isError: false };
    },
    async close() {},
  };
  const services = new RuntimeServices(store, executor, async () => {});
  // Observe the hook boundary without launching an actual shell command.
  services.runHooks = async (kind) => {
    if (kind === 'before_tool') beforeHooks++;
  };
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'source');
    saveConfig({
      ...loadConfig(),
      hooks: [{ name: 'guard', event: 'before_tool', command: 'true', enabled: true }],
    });
    const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
    let modelCalls = 0;
    const runner = new AgentRunner(
      store,
      {
        async complete() {
          return ++modelCalls === 1
            ? {
                text: '',
                calls: ['a', 'b'].map((id) => ({
                  id,
                  name: 'read_file' as const,
                  input: { path: 'a.txt' },
                })),
              }
            : { text: 'done', calls: [] };
        },
      },
      executor,
      {
        text() {},
        notice() {},
        async approve() {
          return false;
        },
      },
      services,
    );
    await runner.run(session, 'read');
    assert.equal(maximum, 1);
    assert.equal(beforeHooks, 2);
  } finally {
    await services.close();
    store.close();
    if (previousHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const fail of [false, true]) {
  test(`read batches are bounded, joined and ordered in model context (failure=${fail})`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-parallel-'));
    const previousHome = process.env.BRUIN_HOME;
    process.env.BRUIN_HOME = path.join(dir, 'home');
    const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
    try {
      const session = store.createSession(dir, {
        alias: 'test',
        provider: 'openai',
        model: 'mock',
      });
      const calls: ToolCall[] = Array.from({ length: 5 }, (_, i) => {
        fs.writeFileSync(path.join(dir, `${i}.txt`), String(i));
        return { id: String(i), name: 'read_file', input: { path: `${i}.txt` } };
      });
      const started: string[] = [];
      const finished: string[] = [];
      const releases: Array<{ resolve(value: ToolResult): void; reject(error: Error): void }> = [];
      let active = 0;
      let maximum = 0;
      let modelCalls = 0;
      const runner = new AgentRunner(
        store,
        {
          async complete(_profile, prompt) {
            if (++modelCalls === 1) return { text: '', calls };
            assert.equal(active, 0);
            const results = prompt.filter((m) => m.role === 'tool').flatMap((m) => m.content);
            assert.deepEqual(
              results.filter((part) => part.type === 'tool-result').map((part) => part.toolCallId),
              ['0', '1', '2', '3', '4'],
            );
            return { text: 'done', calls: [] };
          },
        },
        {
          async execute(request) {
            const id = String(request.input.path).split('.')[0];
            started.push(id);
            maximum = Math.max(maximum, ++active);
            try {
              if (started.length <= 3) {
                const result = new Promise<ToolResult>((resolve, reject) =>
                  releases.push({ resolve, reject }),
                );
                if (started.length === 3) {
                  if (fail) {
                    releases[1].reject(new Error('read interrupted'));
                    setImmediate(() => {
                      releases[2].resolve({ output: '2', isError: false });
                      releases[0].resolve({ output: '0', isError: false });
                    });
                  } else {
                    setImmediate(() => {
                      releases[2].resolve({ output: '2', isError: false });
                      releases[1].resolve({ output: '1', isError: false });
                      releases[0].resolve({ output: '0', isError: false });
                    });
                  }
                }
                return await result;
              }
              return { output: id, isError: false };
            } finally {
              active--;
              finished.push(id);
            }
          },
          async close() {},
        },
        {
          text() {},
          notice() {},
          async approve() {
            throw new Error('reads must not ask');
          },
        },
      );
      if (fail) {
        await assert.rejects(runner.run(session, 'read files'), /read interrupted/);
        assert.deepEqual(started, ['0', '1', '2']);
        assert.equal(active, 0);
        assert.equal(finished.length, 3);
        assert.equal(modelCalls, 1);
        assert.deepEqual(
          store
            .events(session.id)
            .filter((e) => e.type === 'tool_denied')
            .map((e) => e.payload.callId),
          ['3', '4'],
        );
      } else {
        await runner.run(session, 'read files');
        assert.equal(modelCalls, 2);
        assert.equal(finished[0], '2');
      }
      assert.equal(maximum, 3);
    } finally {
      store.close();
      if (previousHome === undefined) delete process.env.BRUIN_HOME;
      else process.env.BRUIN_HOME = previousHome;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
