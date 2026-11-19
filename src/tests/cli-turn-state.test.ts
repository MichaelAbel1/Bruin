import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteEventStore } from '../storage/event-store.js';
import { enqueueInput, pendingInputs } from '../core/input-queue.js';

async function runCli(options: {
  completed?: boolean;
  paused?: boolean;
  configuredAfterCompletion?: boolean;
  queuedAfterCompletion?: 'steer' | 'follow-up';
  commands?: string[];
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-cli-turn-state-'));
  const home = path.join(dir, 'home');
  const file = path.join(home, 'sessions.sqlite');
  const store = new SqliteEventStore(file);
  const session = store.createSession(dir, {
    alias: 'test',
    provider: 'openai-compatible',
    model: 'mock',
  });
  const marker = path.join(dir, 'model-calls');
  fs.writeFileSync(path.join(dir, 'source.txt'), 'source');
  if (options.completed || options.paused) {
    store.append(session.id, 'user', { text: 'original request' });
    store.append(session.id, 'assistant', { text: 'done', calls: [] });
    store.append(session.id, options.paused ? 'turn_paused' : 'turn_completed', {});
    store.append(session.id, 'background_finished', { id: 'late', status: 'completed' });
    if (options.configuredAfterCompletion)
      store.append(session.id, 'run_configured', { maxModelCalls: 96 });
  }
  if (options.queuedAfterCompletion)
    enqueueInput(store, session.id, {
      id: 'late-input',
      mode: options.queuedAfterCompletion,
      text: 'verify from the queue',
      attachments: [],
    });
  const initialTurn = !options.completed && !options.paused;
  const args = ['bruin', 'chat', '--resume', session.id, ...(initialTurn ? ['inspect'] : [])];
  const script = `
    import fs from 'node:fs';
    import { SqliteEventStore } from ${JSON.stringify(new URL('../storage/event-store.js', import.meta.url).href)};
    import { AiSdkGateway } from ${JSON.stringify(new URL('../providers/gateway.js', import.meta.url).href)};
    process.argv = [process.execPath, ...${JSON.stringify(args)}];
    ${options.commands ? "Object.defineProperty(process.stdin, 'isTTY', { value: true });" : ''}
    const append = SqliteEventStore.prototype.append;
    SqliteEventStore.prototype.append = function(id, type, payload) {
      const result = append.call(this, id, type, payload);
      if (type === 'turn_paused') append.call(this, id, 'background_finished', { id: 'late', status: 'completed' });
      return result;
    };
    let calls = 0;
    AiSdkGateway.prototype.complete = async (_profile, prompt) => {
      fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(prompt.filter(message => message.role === 'user').at(-1)?.content ?? null) + '\\n');
      if (++calls === 1 && ${initialTurn}) return { text: '', calls: [{ id: 'read', name: 'read_file', input: { path: 'source.txt' } }] };
      return { text: 'done', calls: [] };
    };
    await import(${JSON.stringify(new URL('../cli.js', import.meta.url).href)});
  `;
  const scriptFile = path.join(dir, 'run-cli.mjs');
  fs.writeFileSync(scriptFile, script);
  const child = spawn(process.execPath, [scriptFile], {
    cwd: dir,
    env: { ...process.env, BRUIN_HOME: home, BRUIN_MAX_STEPS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!options.commands) child.stdin.end();
  let stdout = '';
  let stderr = '';
  let sent = 0;
  child.stdout.setEncoding('utf8').on('data', (data) => {
    stdout += data;
    const prompts = [...stdout.matchAll(/你> /g)].length;
    while (sent < prompts && sent < (options.commands?.length ?? 0))
      child.stdin.write(options.commands![sent++] + '\n');
  });
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    assert.equal(exit.signal, null, stdout + stderr);
    const modelInputs = fs.existsSync(marker)
      ? fs
          .readFileSync(marker, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
    return {
      code: exit.code,
      stdout,
      stderr,
      calls: modelInputs.length,
      modelInputs,
      events: store.events(session.id),
      leased: store.isLeased(session.id),
      content: fs.readFileSync(path.join(dir, 'source.txt'), 'utf8'),
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdin.destroy();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI reads a single prompt source before creating a noninteractive session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-cli-stdin-'));
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const db = path.join(home, 'sessions.sqlite');
    const model = { alias: 'test', provider: 'openai-compatible', model: 'mock' };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profiles: [model] }));
    const preloader = path.join(dir, 'mock-model.mjs');
    const gateway = new URL('../providers/gateway.js', import.meta.url).href;
    fs.writeFileSync(
      preloader,
      `
      import { AiSdkGateway } from ${JSON.stringify(gateway)};
      AiSdkGateway.prototype.complete = async () => ({ text: 'done', calls: [] });
    `,
    );
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const run = (args: string[], input: string | Buffer) =>
      spawnSync(
        process.execPath,
        ['--import', preloader, cli, 'chat', '--model', 'test', ...args],
        {
          cwd: dir,
          env: { ...process.env, BRUIN_HOME: home },
          input,
          encoding: 'utf8',
          timeout: 5000,
        },
      );
    for (const [args, input, error] of [
      [['positional'], 'piped\n', /只通过 stdin 或位置参数/],
      [[], '', /需要提示词或 --resume/],
      [[], '  \n\t ', /需要提示词或 --resume/],
      [[], Buffer.from([0xc3, 0x28]), /有效的 UTF-8/],
      [[], Buffer.alloc(1_000_001, 'x'), /超过 1 MB/],
    ] as const) {
      const failed = run([...args], input);
      assert.equal(failed.status, 1, String(failed.error ?? failed.stderr));
      assert.match(failed.stderr, error);
      assert.equal(fs.existsSync(db), false);
    }
    const piped = '第一行\n  第二行保留缩进\n';
    const positional = 'inspect the workspace';
    for (const [args, text] of [
      [[], piped],
      [[positional], ' \n'],
    ] as const) {
      const success = run([...args], text);
      assert.equal(success.status, 0, String(success.error ?? success.stderr));
    }
    const store = new SqliteEventStore(db);
    try {
      const sessions = store.listSessions();
      assert.equal(sessions.length, 2);
      const prompts = sessions.map((session) => {
        const events = store.events(session.id);
        const user = events.filter((event) => event.type === 'user');
        assert.equal(user.length, 1);
        assert.equal(events.at(-1)?.type, 'turn_completed');
        return user[0].payload.text;
      });
      assert.deepEqual(new Set(prompts), new Set([piped, positional]));
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI resumes a paused run after empty stdin without creating a new user turn', async () => {
  const result = await runCli({ paused: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls, 1);
  assert.equal(result.events.filter((event) => event.type === 'user').length, 1);
  assert.equal(result.events.at(-1)?.type, 'turn_completed');
});

test('CLI preserves the budget exit code after a late background result', async () => {
  const result = await runCli({});
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.calls, 1);
  assert.equal(result.leased, false);
  assert.equal(result.content, 'source');
});

test('CLI does not resume a completed conversation just because background metadata arrived', async () => {
  const result = await runCli({ completed: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls, 0);
  assert.equal(result.events.filter((event) => event.type === 'turn_completed').length, 1);
});

for (const mode of ['steer', 'follow-up'] as const) {
  test(`CLI resumes a retained ${mode} message after the previous turn completed`, async () => {
    const result = await runCli({ completed: true, queuedAfterCompletion: mode });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.modelInputs, ['verify from the queue']);
    assert.equal(pendingInputs(result.events).length, 0);
    assert.equal(
      result.events.filter(
        (event) => event.type === 'user' && event.payload.queuedInputId === 'late-input',
      ).length,
      1,
    );
    assert.equal(result.events.filter((event) => event.type === 'turn_completed').length, 2);
  });
}

test('CLI does not resume a completed turn when the next run lost its input before persisting it', async () => {
  const result = await runCli({ completed: true, configuredAfterCompletion: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls, 0);
  assert.equal(result.events.at(-1)?.type, 'run_configured');
});

test('CLI can explicitly stop a paused turn after background metadata arrived', async () => {
  const result = await runCli({ commands: ['/stop', '/exit'] });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已结束暂停的任务/);
  assert.equal(result.events.at(-1)?.type, 'turn_completed');
  assert.equal(result.events.at(-1)?.payload.stoppedByUser, true);
});

test('CLI can continue a paused turn after background metadata arrived without replaying the read', async () => {
  const result = await runCli({ commands: ['/continue', '/exit'] });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls, 2);
  assert.equal(result.events.filter((event) => event.type === 'tool_started').length, 1);
  assert.equal(result.events.at(-1)?.type, 'turn_completed');
});
