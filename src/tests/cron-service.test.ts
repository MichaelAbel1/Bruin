import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteEventStore } from '../storage/event-store.js';
import { recoverCronJobs } from '../runtime/cron.js';

test('cron claims are durable, leased sessions are deferred, abandoned runs require review', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-cron-'));
  const file = path.join(dir, 'sessions.sqlite');
  let store = new SqliteEventStore(file);
  try {
    const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
    const job = store.createCronJob(session.id, '* * * * *', 'check');
    store.acquireLease(session.id, 'other', 30_000);
    assert.deepEqual(store.takeDueCronJobs(job.nextRunAt), []);
    store.releaseLease(session.id, 'other');
    assert.equal(store.takeDueCronJobs(job.nextRunAt)[0].id, job.id);
    assert.equal(store.events(session.id).at(-1)?.type, 'cron_started');
    recoverCronJobs(store);
    assert.equal(store.listCronJobs(session.id)[0].lastStatus, 'dispatched');
    store.close();
    store = new SqliteEventStore(file);
    recoverCronJobs(store, Date.now() + 31_000);
    assert.equal(store.listCronJobs(session.id)[0].lastStatus, 'needs_review');
    assert.equal(store.events(session.id).at(-1)?.payload.status, 'needs_review');
    assert.deepEqual(store.takeDueCronJobs(job.nextRunAt + 120_000), []);
    recoverCronJobs(store, Date.now() + 31_000);
    assert.equal(
      store.events(session.id).filter((event) => event.type === 'cron_finished').length,
      1,
    );
    store.markCronJob(job.id, 'reviewed');
    assert.equal(store.takeDueCronJobs(job.nextRunAt + 120_000).length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'independent service runs without desktop and shuts down on SIGTERM',
  { timeout: 10_000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-service-'));
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../cli.js', import.meta.url)),
        'service',
        'run',
        '--timezone',
        'Asia/Shanghai',
      ],
      {
        env: { ...process.env, BRUIN_HOME: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let error = '';
    child.stderr.on('data', (data) => {
      error += data;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(path.join(dir, 'sessions.sqlite'))) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(error || 'service did not start');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      child.kill('SIGTERM');
      assert.equal(await exited, 0, error);
    } finally {
      child.kill('SIGTERM');
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
