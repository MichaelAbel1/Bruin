import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteEventStore } from '../storage/event-store.js';

test('noninteractive CLI requires review on every resume until a receipt exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-cli-recovery-repeat-'));
  const dataDir = path.join(dir, 'home');
  const store = new SqliteEventStore(path.join(dataDir, 'sessions.sqlite'));
  try {
    const session = store.createSession(dir, {
      alias: 'test',
      provider: 'openai',
      model: 'test',
      apiKeyEnv: 'BRUIN_TEST_UNCONFIGURED_KEY',
    });
    store.append(session.id, 'user', { text: 'Inspect the workspace' });
    store.append(session.id, 'assistant', {
      text: '',
      calls: [
        {
          id: 'before-crash',
          name: 'write_file',
          input: { path: 'result.txt', content: 'example' },
        },
      ],
    });
    store.append(session.id, 'tool_started', {
      callId: 'before-crash',
      name: 'write_file',
      recovery: 'manual',
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../cli.js', import.meta.url)), 'chat', '--resume', session.id],
        {
          cwd: dir,
          env: { ...process.env, BRUIN_HOME: dataDir, BRUIN_TEST_UNCONFIGURED_KEY: '' },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stderr, /1 个结果未知/);
      assert.equal(store.isLeased(session.id), false);
      const events = store.events(session.id);
      assert.equal(events.filter((event) => event.type === 'tool_unknown').length, 1);
      assert.equal(
        events.some((event) =>
          ['run_configured', 'model_error', 'turn_completed'].includes(event.type),
        ),
        false,
      );
      assert.equal(fs.existsSync(path.join(dir, 'result.txt')), false);
    }

    const script = `
      import { AiSdkGateway } from ${JSON.stringify(new URL('../providers/gateway.js', import.meta.url).href)};
      if (process.env.BRUIN_TEST_INTERACTIVE === '1') Object.defineProperty(process.stdin, 'isTTY', { value: true });
      process.argv = [process.execPath, 'bruin', 'chat', '--resume', ${JSON.stringify(session.id)}];
      AiSdkGateway.prototype.complete = async () => { throw new Error('mock model unavailable'); };
      await import(${JSON.stringify(new URL('../cli.js', import.meta.url).href)});
    `;
    const env = { ...process.env, BRUIN_HOME: dataDir };
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...env, BRUIN_TEST_INTERACTIVE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let answered = false;
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      stdout += data;
      if (!answered && stdout.includes('[y/N]')) {
        answered = true;
        child.stdin.write('y\n');
      }
    });
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      stderr += data;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal }));
        },
      );
      assert.equal(exit.signal, null);
      assert.equal(exit.code, 1, stderr);
      assert.equal(answered, true);
      assert.match(stderr, /mock model unavailable/);
    } finally {
      clearTimeout(timer);
      child.stdin.destroy();
    }
    const events = store.events(session.id);
    const unknown = events.find((event) => event.type === 'tool_unknown')!;
    const receipt = events.find((event) => event.type === 'unknown_reviewed')!;
    assert.deepEqual(receipt.payload, { throughSeq: unknown.seq, source: 'cli' });
    assert.ok(receipt.seq < events.find((event) => event.type === 'model_error')!.seq);
    const next = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...env, BRUIN_TEST_INTERACTIVE: '0' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(next.status, 1, next.stderr);
    assert.match(next.stderr, /mock model unavailable/);
    assert.equal(
      store.events(session.id).filter((event) => event.type === 'unknown_reviewed').length,
      1,
    );
    assert.equal(store.isLeased(session.id), false);
    assert.equal(fs.existsSync(path.join(dir, 'result.txt')), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const waitingAt of ['approval', 'recovery', 'input'] as const) {
  for (const cancellation of ['interrupt', 'lease-loss', 'deadline'] as const) {
    if (cancellation === 'deadline' && waitingAt !== 'approval') continue;
    test(`CLI ${waitingAt} wait exits and releases ownership after ${cancellation}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-cli-cancel-'));
      const home = path.join(dir, 'home');
      const store = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
      const session = store.createSession(dir, {
        alias: 'test',
        provider: 'openai-compatible',
        model: 'test',
      });
      if (waitingAt === 'recovery')
        store.append(session.id, 'tool_unknown', {
          callId: 'interrupted',
          name: 'write_file',
          output: 'Result was already recorded as unknown',
        });
      const marker =
        waitingAt === 'approval'
          ? '批准 write_file'
          : waitingAt === 'recovery'
            ? '1 个结果未知'
            : '你> ';
      const script = `
        import { SqliteEventStore } from ${JSON.stringify(new URL('../storage/event-store.js', import.meta.url).href)};
        import { AiSdkGateway } from ${JSON.stringify(new URL('../providers/gateway.js', import.meta.url).href)};
        Object.defineProperty(process.stdin, 'isTTY', { value: true });
        process.argv = [process.execPath, 'bruin', 'chat', '--resume', ${JSON.stringify(session.id)}${cancellation === 'deadline' ? ", '--max-model-calls', '96'" : ''}${waitingAt === 'approval' ? ", 'change'" : ''}];
        let expire;
        if (${cancellation === 'deadline'}) {
          const timeout = globalThis.setTimeout;
          globalThis.setTimeout = (fn, delay, ...args) => {
            if (delay === 8 * 60 * 60 * 1000) expire = () => fn(...args);
            return timeout(fn, delay, ...args);
          };
        }
        AiSdkGateway.prototype.complete = async () => ({ text: '', calls: [{ id: 'write', name: 'write_file', input: { path: 'result.txt', content: 'changed' } }] });
        const write = process.stdout.write.bind(process.stdout);
        let reached = false;
        process.stdout.write = (...args) => {
          const result = write(...args);
          if (!reached && String(args[0]).includes(${JSON.stringify(marker)})) {
            reached = true;
            ${
              cancellation === 'interrupt'
                ? "setImmediate(() => process.emit('SIGINT'));"
                : cancellation === 'deadline'
                  ? 'setImmediate(expire);'
                  : `
              SqliteEventStore.prototype.renewLease = () => false;
              // Exercise the real registered heartbeat rather than aborting the question directly.
            `
            }
          }
          return result;
        };
        ${
          cancellation === 'lease-loss'
            ? `
          const interval = globalThis.setInterval;
          globalThis.setInterval = (fn, delay, ...args) => interval(fn, delay === 10_000 ? 100 : delay, ...args);
        `
            : ''
        }
        await import(${JSON.stringify(new URL('../cli.js', import.meta.url).href)});
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: dir,
        env: { ...process.env, BRUIN_HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let error = '';
      let timedOut = false;
      let sentExit = false;
      child.stdout.on('data', (data) => {
        output += data;
        if (cancellation === 'deadline' && !sentExit && output.includes('你> ')) {
          sentExit = true;
          child.stdin.write('/exit\n');
        }
      });
      child.stderr.on('data', (data) => {
        error += data;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 5000);
      try {
        const exit = await new Promise<{ code: number | null; signal: string | null }>(
          (resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => resolve({ code, signal }));
          },
        );
        assert.equal(
          timedOut,
          false,
          `${waitingAt} did not respond to cancellation: ${output} ${error}`,
        );
        assert.equal(exit.signal, null);
        assert.equal(exit.code, cancellation === 'deadline' ? 0 : 1, error);
        assert.ok(output.includes(marker), output);
        if (cancellation === 'deadline') {
          assert.equal(error, '');
          assert.equal(store.events(session.id).at(-1)?.payload.reason, 'time_limit');
          assert.equal(
            store.events(session.id).filter((event) => event.type === 'tool_denied').length,
            1,
          );
        } else assert.match(error, /aborted|取消/);
        assert.equal(store.isLeased(session.id), false);
        assert.equal(fs.existsSync(path.join(dir, 'result.txt')), false);
        assert.equal(
          store.events(session.id).some((event) => event.type === 'tool_started'),
          false,
        );
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        child.stdin.destroy();
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
