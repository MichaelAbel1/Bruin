import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SqliteEventStore } from '../storage/event-store.js';

for (const waitingAt of ['approval', 'recovery', 'input'] as const) {
  for (const cancellation of ['interrupt', 'lease-loss'] as const) {
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
        store.append(session.id, 'assistant', {
          text: '',
          calls: [
            {
              id: 'pending',
              name: 'write_file',
              input: { path: 'result.txt', content: 'changed' },
            },
          ],
        });
      const marker =
        waitingAt === 'approval' ? '批准 write_file' : waitingAt === 'recovery' ? '[y/N]' : '你> ';
      const script = `
        import { SqliteEventStore } from ${JSON.stringify(new URL('../storage/event-store.js', import.meta.url).href)};
        import { AiSdkGateway } from ${JSON.stringify(new URL('../providers/gateway.js', import.meta.url).href)};
        Object.defineProperty(process.stdin, 'isTTY', { value: true });
        process.argv = [process.execPath, 'bruin', 'chat', '--resume', ${JSON.stringify(session.id)}${waitingAt === 'approval' ? ", 'change'" : ''}];
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
      child.stdout.on('data', (data) => {
        output += data;
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
        assert.equal(exit.code, 1, error);
        assert.ok(output.includes(marker), output);
        assert.match(error, /aborted|取消/);
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
