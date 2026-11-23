import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteEventStore } from '../storage/event-store.js';
import { recoverCronJobs } from '../runtime/cron.js';
import { recoverSession } from '../core/recovery.js';
import { needsUnknownReview } from '../core/unknown-review.js';
import { loadConfig, saveConfig } from '../config.js';

for (const outcome of [
  'success',
  'failed-result',
  'execution-error',
  'receipt-error',
  'lease-contention',
  'bound-incomplete',
  'bound-completed',
  'unbound-incomplete',
  'plan-replaced',
] as const) {
  const failedHook = ['failed-result', 'execution-error', 'receipt-error'].includes(outcome);
  const needsReview = failedHook || outcome === 'bound-incomplete' || outcome === 'plan-replaced';
  test(
    `scheduler classifies the current turn after a finishing hook (${outcome})`,
    { timeout: 10_000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-cron-terminal-'));
      const home = path.join(dir, 'home');
      const store = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
      const profile = {
        alias: 'test',
        provider: 'openai-compatible' as const,
        model: 'mock',
        baseUrl: 'http://localhost:9999/v1',
      };
      const session = store.createSession(dir, profile);
      // A historical failed hook must not contaminate the new dispatch.
      store.append(session.id, 'user', { text: 'previous task' });
      store.append(session.id, 'assistant', { text: 'previous answer', calls: [] });
      store.append(session.id, 'turn_completed', {});
      store.append(session.id, 'hook_finished', {
        name: 'old',
        event: 'turn_finished',
        isError: true,
        output: 'old failure',
      });
      let planSeq: number | undefined;
      if (outcome.includes('bound-') || outcome === 'plan-replaced') {
        store.append(session.id, 'plan_mode', { enabled: true });
        const plan = store.append(session.id, 'plan_updated', { steps: ['Verify the change'] });
        store.append(session.id, 'plan_approved', {});
        if (outcome !== 'unbound-incomplete') planSeq = plan.seq;
      }
      store.createCronJob(session.id, '* * * * *', 'scheduled task', planSeq);
      if (outcome === 'plan-replaced') {
        store.append(session.id, 'plan_updated', { steps: ['A different task'] });
        store.append(session.id, 'plan_approved', {});
      }
      const previous = process.env.BRUIN_HOME;
      process.env.BRUIN_HOME = home;
      try {
        saveConfig({
          ...loadConfig(),
          profiles: [profile],
          defaultProfile: 'test',
          ...(outcome === 'bound-completed' ? { approvalMode: 'auto' } : {}),
          hooks: [{ name: 'check', event: 'turn_finished', command: 'verify', enabled: true }],
        });
      } finally {
        if (previous === undefined) delete process.env.BRUIN_HOME;
        else process.env.BRUIN_HOME = previous;
      }
      const script = path.join(dir, 'service.mjs');
      const trace = path.join(dir, 'hooks.jsonl');
      fs.writeFileSync(
        script,
        `
      import fs from 'node:fs';
      import { AiSdkGateway } from ${JSON.stringify(new URL('../providers/gateway.js', import.meta.url).href)};
      import { ProcessExecutor } from ${JSON.stringify(new URL('../executor/client.js', import.meta.url).href)};
      import { SqliteEventStore } from ${JSON.stringify(new URL('../storage/event-store.js', import.meta.url).href)};
      let modelCalls = 0;
      AiSdkGateway.prototype.complete = async () => {
        if (${outcome === 'plan-replaced'}) throw new Error('a replaced plan must not start');
        if (++modelCalls === 1 && ${outcome === 'bound-completed'}) {
          return { text: '', calls: [{ id: 'mark-verified', name: 'update_plan_progress', input: { index: 0, status: 'completed' } }] };
        }
        return { text: 'scheduled answer', calls: [] };
      };
      ProcessExecutor.prototype.execute = async (request) => {
        fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(request) + '\\n');
        if (${outcome === 'execution-error'}) throw new Error('hook worker disconnected');
        return { output: 'hook result', isError: ${outcome === 'failed-result'} };
      };
      const take = SqliteEventStore.prototype.takeDueCronJobs;
      SqliteEventStore.prototype.takeDueCronJobs = function(now) { return take.call(this, now + 61000); };
      if (${outcome === 'lease-contention'}) {
        const release = SqliteEventStore.prototype.releaseLease;
        SqliteEventStore.prototype.releaseLease = function(id, owner) {
          release.call(this, id, owner);
          if (this.listCronJobs(id).some((job) => job.lastStatus === 'dispatched')) {
            // A manual client can obtain the session and write a new turn as soon as the lease is released.
            this.acquireLease(id, 'manual-client', 30000);
            this.append(id, 'user', { text: 'a later interactive turn' });
            release.call(this, id, 'manual-client');
          }
        };
      }
      const append = SqliteEventStore.prototype.append;
      SqliteEventStore.prototype.append = function(id, type, payload) {
        if (${outcome === 'receipt-error'} && type === 'hook_finished' && payload.name === 'check') throw new Error('hook receipt write failed');
        return append.call(this, id, type, payload);
      };
      const interval = globalThis.setInterval;
      globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 15000 ? 20 : ms, ...args);
      await import(${JSON.stringify(new URL('../desktop-host.js', import.meta.url).href)});
    `,
      );
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, BRUIN_HOME: home, BRUIN_SERVICE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stdout.on('data', () => {});
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      const exited = new Promise<void>((resolve, reject) => {
        child.once('exit', () => resolve());
        child.once('error', reject);
      });
      try {
        const deadline = Date.now() + 6000;
        while (
          !['completed', 'needs_review'].includes(
            store.listCronJobs(session.id)[0].lastStatus ?? '',
          )
        ) {
          assert.ok(
            child.exitCode === null && Date.now() < deadline,
            stderr || 'scheduler did not settle',
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          store.listCronJobs(session.id)[0].lastStatus,
          needsReview ? 'needs_review' : 'completed',
        );
        const events = store.events(session.id);
        const dispatched = events.filter((event) => event.type === 'cron_started');
        const settled = events.filter((event) => event.type === 'cron_finished');
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].payload.planSeq, planSeq);
        assert.equal(settled.length, 1);
        if (outcome === 'plan-replaced') {
          assert.match(String(settled[0].payload.detail), /已变更/);
          assert.equal(events.filter((event) => event.type === 'user').length, 1);
          assert.equal(fs.existsSync(trace), false);
          return;
        }
        if (outcome === 'bound-incomplete')
          assert.match(String(settled[0].payload.detail), /未完成步骤.*Verify the change/);
        else assert.equal(settled[0].payload.detail, undefined);
        if (outcome === 'bound-completed')
          assert.ok(
            events.some(
              (event) => event.type === 'plan_progress' && event.payload.status === 'completed',
            ),
          );
        assert.equal(events.filter((event) => event.type === 'turn_completed').length, 2);
        const hook = events.find(
          (event) => event.type === 'hook_finished' && event.payload.name === 'check',
        );
        if (outcome === 'receipt-error') assert.equal(hook, undefined);
        else {
          assert.equal(hook?.payload.isError, failedHook);
          assert.equal(hook?.payload.executionUnknown === true, outcome === 'execution-error');
        }
        const requests = fs
          .readFileSync(trace, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].requireSandbox, true);
      } finally {
        child.kill('SIGTERM');
        await exited;
        child.stdin.destroy();
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

for (const failure of ['startup', 'settlement'] as const) {
  test(
    `scheduler only requeues an unstarted task after a ${failure} error`,
    { timeout: 10_000 },
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-task-scheduler-'));
      const home = path.join(dir, 'home');
      const store = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
      const session = store.createSession(dir, {
        alias: 'test',
        provider: 'openai-compatible',
        model: 'mock',
        baseUrl: 'http://localhost:9999/v1',
      });
      const task = store.createTask(session.id, 'first task', []);
      const downstream = store.createTask(session.id, 'dependent task', [task.id]);
      const script = path.join(dir, 'service.mjs');
      const ticks = path.join(dir, 'ticks');
      fs.writeFileSync(
        script,
        `
      import fs from 'node:fs';
      import { AiSdkGateway } from ${JSON.stringify(new URL('../providers/gateway.js', import.meta.url).href)};
      import { SqliteEventStore } from ${JSON.stringify(new URL('../storage/event-store.js', import.meta.url).href)};
      AiSdkGateway.prototype.complete = async () => ({ text: 'task processed', calls: [] });
      let failed = false;
      function failOnce() {
        if (failed) return;
        failed = true;
        fs.writeFileSync(${JSON.stringify(ticks)}, '');
        throw new Error('simulated ${failure} failure');
      }
      const append = SqliteEventStore.prototype.append;
      SqliteEventStore.prototype.append = function(id, type, payload) {
        if (${failure === 'startup'} && type === 'run_configured') failOnce();
        return append.call(this, id, type, payload);
      };
      const finish = SqliteEventStore.prototype.finishTask;
      SqliteEventStore.prototype.finishTask = function(...args) {
        if (${failure === 'settlement'}) failOnce();
        return finish.apply(this, args);
      };
      const interval = globalThis.setInterval;
      globalThis.setInterval = (fn, ms, ...args) => {
        if (ms !== 15000) return interval(fn, ms, ...args);
        return interval(() => {
          if (failed) fs.appendFileSync(${JSON.stringify(ticks)}, '.');
          fn();
        }, 20);
      };
      await import(${JSON.stringify(new URL('../desktop-host.js', import.meta.url).href)});
    `,
      );
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, BRUIN_HOME: home, BRUIN_SERVICE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      try {
        const deadline = Date.now() + 6000;
        while (
          !fs.existsSync(ticks) ||
          fs.statSync(ticks).size < 3 ||
          !store.events(session.id).some((event) => event.type === 'turn_completed')
        ) {
          assert.ok(
            child.exitCode === null && Date.now() < deadline,
            stderr || 'scheduler did not finish the turn and attempt further ticks',
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        child.stdin.end();
        assert.equal(await exited, 0, stderr);
        assert.equal(store.events(session.id).filter((event) => event.type === 'user').length, 1);
        const status = (id: string) =>
          store.listTasks(session.id).find((row) => row.id === id)?.status;
        assert.equal(status(task.id), failure === 'startup' ? 'failed' : 'running');
        const afterExpiry = Date.now() + 3_600_001;
        t.mock.method(Date, 'now', () => afterExpiry);
        assert.equal(store.claimTask(session.id, 'another-scheduler', 1000), undefined);
        assert.equal(status(task.id), failure === 'startup' ? 'failed' : 'unknown');
        assert.equal(status(downstream.id), 'pending');
      } finally {
        child.kill('SIGTERM');
        await exited;
        child.stdin.destroy();
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

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

for (const race of ['new-dispatch', 'lease-contention'] as const) {
  test(`cron recovery rechecks its candidate after a concurrent ${race}`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-cron-recovery-race-'));
    const file = path.join(dir, 'sessions.sqlite');
    const first = new SqliteEventStore(file);
    const second = new SqliteEventStore(file);
    try {
      const profile = { alias: 'test', provider: 'openai' as const, model: 'mock' };
      const session = first.createSession(dir, profile);
      const other = first.createSession(dir, profile);
      const job = first.createCronJob(session.id, '* * * * *', 'first task');
      const abandoned = first.createCronJob(other.id, '* * * * *', 'other task');
      const due = Math.max(job.nextRunAt, abandoned.nextRunAt);
      assert.equal(first.takeDueCronJobs(due).length, 1);
      assert.equal(first.takeDueCronJobs(due).length, 1);
      const acquire = first.acquireLease.bind(first);
      t.mock.method(first, 'acquireLease', (id: string, owner: string, ttlMs: number) => {
        if (id === session.id) {
          if (race === 'new-dispatch') {
            second.markCronJob(job.id, 'completed');
            assert.equal(second.takeDueCronJobs(due + 120_000)[0]?.id, job.id);
          } else second.acquireLease(id, 'active-runner', 30_000);
        }
        return acquire(id, owner, ttlMs);
      });

      recoverCronJobs(first, Date.now() + 31_000);

      assert.equal(first.listCronJobs(session.id)[0].lastStatus, 'dispatched');
      assert.equal(first.listCronJobs(other.id)[0].lastStatus, 'needs_review');
      const events = first.events(session.id);
      assert.equal(
        events.filter((event) => event.type === 'cron_started').length,
        race === 'new-dispatch' ? 2 : 1,
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === 'cron_finished')
          .map((event) => event.payload.status),
        race === 'new-dispatch' ? ['completed'] : [],
      );
    } finally {
      second.close();
      first.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a dispatched job reserves its session before the runner obtains a lease', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-cron-concurrent-'));
  const file = path.join(dir, 'sessions.sqlite');
  const first = new SqliteEventStore(file);
  const second = new SqliteEventStore(file);
  try {
    const profile = { alias: 'test', provider: 'openai' as const, model: 'mock' };
    const session = first.createSession(dir, profile);
    const other = first.createSession(dir, profile);
    const a = first.createCronJob(session.id, '0 * * * *', 'first');
    const dispatched = first.takeDueCronJobs(a.nextRunAt)[0];
    assert.equal(dispatched.id, a.id);
    const b = first.createCronJob(session.id, '* * * * *', 'second');
    const c = first.createCronJob(other.id, '* * * * *', 'another session');
    const now = Math.max(a.nextRunAt, b.nextRunAt, c.nextRunAt);

    assert.equal(second.isLeased(session.id), false);
    assert.equal(second.takeDueCronJobs(now)[0]?.id, c.id);
    assert.deepEqual(second.takeDueCronJobs(now), []);
    assert.equal(
      second.listCronJobs(session.id).find((job) => job.id === b.id)?.nextRunAt,
      b.nextRunAt,
    );
    first.markCronJob(dispatched.id, 'completed');
    assert.equal(second.takeDueCronJobs(now)[0]?.id, b.id);
    assert.equal(
      first.events(session.id).filter((event) => event.type === 'cron_started').length,
      2,
    );
  } finally {
    second.close();
    first.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit cron review acknowledges only unknown results already reconciled at confirmation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-cron-review-'));
  const store = new SqliteEventStore(path.join(dir, 'sessions.sqlite'));
  const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
  try {
    const interrupted = (id: string) => {
      store.append(session.id, 'assistant', {
        text: '',
        calls: [{ id, name: 'shell', input: { command: 'external side effect' } }],
      });
      store.append(session.id, 'tool_started', { callId: id, name: 'shell', recovery: 'manual' });
    };
    interrupted('first');
    assert.equal(recoverSession(store, session.id), 1);
    assert.equal(recoverSession(store, session.id), 0);
    assert.equal(needsUnknownReview(store.events(session.id)), true);
    const throughSeq = store.events(session.id).at(-1)!.seq;
    store.append(session.id, 'cron_reviewed', { jobId: 'job', throughSeq });
    assert.equal(needsUnknownReview(store.events(session.id)), false);
    interrupted('later');
    recoverSession(store, session.id);
    assert.equal(needsUnknownReview(store.events(session.id)), true);
    assert.equal(
      store.events(session.id).filter((event) => event.type === 'tool_started').length,
      2,
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cron review keeps the job blocked when confirmation discovers a previously unseen unknown result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-cron-cli-review-'));
  const store = new SqliteEventStore(path.join(dir, 'sessions.sqlite'));
  try {
    const session = store.createSession(dir, { alias: 'test', provider: 'openai', model: 'mock' });
    const job = store.createCronJob(session.id, '* * * * *', 'scheduled task');
    store.takeDueCronJobs(job.nextRunAt);
    store.markCronJob(job.id, 'needs_review');
    store.append(session.id, 'assistant', {
      text: '',
      calls: [{ id: 'write', name: 'write_file', input: { path: 'fixture.txt', content: 'test' } }],
    });
    store.append(session.id, 'tool_started', {
      callId: 'write',
      name: 'write_file',
      recovery: 'manual',
    });
    const review = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../cli.js', import.meta.url)),
          'cron',
          'review',
          job.id,
          '--confirm',
        ],
        { env: { ...process.env, BRUIN_HOME: dir }, encoding: 'utf8', timeout: 5000 },
      );
    const first = review();
    assert.equal(first.status, 1, first.stdout + first.stderr);
    assert.match(first.stderr, /新发现.*未知/);
    const reviewedEvents = store.events(session.id);
    const unknown = reviewedEvents.find((event) => event.type === 'tool_unknown')!;
    assert.equal(unknown.payload.callId, 'write');
    assert.equal(
      reviewedEvents.some((event) => event.type === 'cron_reviewed'),
      false,
    );
    assert.equal(store.listCronJobs(session.id)[0].lastStatus, 'needs_review');
    assert.equal(store.isLeased(session.id), false);

    const confirmed = review();
    assert.equal(confirmed.status, 0, confirmed.stderr);
    const events = store.events(session.id);
    assert.deepEqual(events.find((event) => event.type === 'cron_reviewed')?.payload, {
      jobId: job.id,
      throughSeq: unknown.seq,
    });
    assert.equal(events.filter((event) => event.type === 'tool_unknown').length, 1);
    assert.equal(store.listCronJobs(session.id)[0].lastStatus, 'reviewed');
    assert.equal(store.isLeased(session.id), false);
    assert.equal(fs.existsSync(path.join(dir, 'fixture.txt')), false);
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
