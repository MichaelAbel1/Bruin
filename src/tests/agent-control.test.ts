import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../core/agent.js';
import { SqliteEventStore } from '../storage/event-store.js';
import type { ModelGateway } from '../providers/gateway.js';
import type { ToolCall, ToolResult } from '../core/types.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-control-'));
  const previous = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, {
    alias: 'local',
    provider: 'openai-compatible',
    model: 'mock',
    baseUrl: 'http://localhost:9999/v1',
  });
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

for (const cancelAt of ['model', 'approval', 'between-tools'] as const) {
  test(`cancellation at ${cancelAt} prevents unstarted batch effects and false unknown recovery`, async () => {
    const f = fixture();
    const controller = new AbortController();
    let approvals = 0;
    let executions = 0;
    const calls: ToolCall[] = ['one', 'two'].map((id) => ({
      id,
      name: 'write_file',
      input: { path: `${id}.txt`, content: id },
    }));
    const gateway: ModelGateway = {
      async complete() {
        if (cancelAt === 'model') controller.abort();
        return { text: '', calls };
      },
    };
    const runner = new AgentRunner(
      f.store,
      gateway,
      {
        async execute(request): Promise<ToolResult> {
          executions++;
          fs.writeFileSync(
            path.join(f.dir, String(request.input.path)),
            String(request.input.content),
          );
          if (cancelAt === 'between-tools') controller.abort();
          return { output: 'written', isError: false };
        },
        async close() {},
      },
      {
        text() {},
        notice() {},
        async approve() {
          approvals++;
          if (cancelAt === 'approval') controller.abort();
          return true;
        },
      },
    );
    try {
      await assert.rejects(runner.run(f.session, 'write both files', controller.signal), /已取消/);
      assert.equal(executions, cancelAt === 'between-tools' ? 1 : 0);
      assert.equal(approvals, cancelAt === 'model' ? 0 : 1);
      assert.equal(fs.existsSync(path.join(f.dir, 'two.txt')), false);
      assert.equal(runner.recover(f.session), 0);
      assert.equal(
        f.store.events(f.session.id).filter((event) => event.type === 'tool_denied').length,
        cancelAt === 'between-tools' ? 1 : 2,
      );
      assert.equal(
        f.store.events(f.session.id).some((event) => event.type === 'turn_completed'),
        false,
      );
    } finally {
      f.close();
    }
  });
}

test('repeated failed inputs get recovery guidance without leaking their arguments', async () => {
  const f = fixture();
  let prompt = '';
  const notices: string[] = [];
  f.store.append(f.session.id, 'user', { text: 'inspect the project' });
  for (let index = 0; index < 3; index++) {
    f.store.append(f.session.id, 'tool_requested', {
      callId: 'reused',
      name: 'read_file',
      input: { path: 'private-argument' },
    });
    f.store.append(f.session.id, 'tool_finished', {
      callId: 'reused',
      name: 'read_file',
      isError: true,
      output: 'not found',
    });
  }
  const runner = new AgentRunner(
    f.store,
    {
      async complete(_profile, messages) {
        prompt = String(messages[0].content);
        return { text: 'Please provide the correct file path.', calls: [] };
      },
    },
    {
      async execute() {
        throw new Error('unexpected');
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
    await runner.run(f.session);
    assert.match(prompt, /Repeated tool failures detected for: read_file/);
    assert.doesNotMatch(prompt, /private-argument/);
    assert.equal(notices.filter((notice) => notice.includes('多次失败')).length, 1);
    await runner.run(f.session, 'new task');
    assert.doesNotMatch(prompt, /Repeated tool failures/);
  } finally {
    f.close();
  }
});

for (const scenario of ['success-reset', 'distinct-inputs', 'polling'] as const) {
  test(`failure guidance avoids ${scenario} false positives`, async () => {
    const f = fixture();
    f.store.append(f.session.id, 'user', { text: 'inspect' });
    for (let index = 0; index < 4; index++) {
      f.store.append(f.session.id, 'tool_requested', {
        callId: `call-${index}`,
        name: scenario === 'polling' ? 'background_status' : 'read_file',
        input: { path: scenario === 'distinct-inputs' ? `file-${index}` : 'same' },
      });
      f.store.append(f.session.id, 'tool_finished', {
        callId: `call-${index}`,
        isError: !(scenario === 'success-reset' && index === 2),
        output: 'result',
      });
    }
    const runner = new AgentRunner(
      f.store,
      {
        async complete(_profile, messages) {
          assert.doesNotMatch(String(messages[0].content), /Repeated tool failures/);
          return { text: 'done', calls: [] };
        },
      },
      {
        async execute() {
          throw new Error('unexpected');
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
    try {
      await runner.run(f.session);
    } finally {
      f.close();
    }
  });
}

test('partial visible model output is not retried', async () => {
  const f = fixture();
  let attempts = 0;
  let streamed = '';
  const runner = new AgentRunner(
    f.store,
    {
      async complete(_profile, _prompt, _signal, onText) {
        attempts++;
        onText('partial response');
        throw Object.assign(new Error('service unavailable'), { statusCode: 503 });
      },
    },
    {
      async execute() {
        throw new Error('unexpected');
      },
      async close() {},
    },
    {
      text(delta) {
        streamed += delta;
      },
      notice() {},
      async approve() {
        return false;
      },
    },
  );
  try {
    await assert.rejects(runner.run(f.session, 'inspect'), /service unavailable/);
    assert.equal(attempts, 1);
    assert.equal(streamed, 'partial response');
  } finally {
    f.close();
  }
});

test('runner caps gateway-timeout retries at three attempts', async () => {
  const f = fixture();
  let attempts = 0;
  const runner = new AgentRunner(
    f.store,
    {
      async complete() {
        attempts++;
        throw Object.assign(new Error('gateway timeout'), { statusCode: 504 });
      },
    },
    {
      async execute() {
        throw new Error('unexpected');
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
  try {
    await assert.rejects(runner.run(f.session, 'inspect'), /HTTP 504/);
    assert.equal(attempts, 3);
    assert.equal(
      f.store.events(f.session.id).filter((event) => event.type === 'model_error').length,
      1,
    );
  } finally {
    f.close();
  }
});

test('prototype property tool names are denied as unknown without reaching approval', async () => {
  const f = fixture();
  let attempts = 0;
  const runner = new AgentRunner(
    f.store,
    {
      async complete() {
        attempts++;
        return {
          text: 'done',
          calls:
            attempts === 1
              ? ['constructor', 'toString', '__proto__'].map((name, index) => ({
                  id: String(index),
                  name: name as ToolCall['name'],
                  input: {},
                }))
              : [],
        };
      },
    },
    {
      async execute() {
        throw new Error('must not execute');
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
  try {
    await runner.run(f.session, 'inspect');
    assert.equal(
      f.store.events(f.session.id).filter((event) => event.type === 'tool_denied').length,
      3,
    );
    assert.equal(f.store.events(f.session.id).at(-1)?.type, 'turn_completed');
  } finally {
    f.close();
  }
});
