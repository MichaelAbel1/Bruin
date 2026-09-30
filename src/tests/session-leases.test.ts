import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteEventStore } from '../storage/event-store.js';
import { SessionLeases } from '../core/session-leases.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-session-leases-'));
  const file = path.join(dir, 'db.sqlite');
  const store = new SqliteEventStore(file);
  const other = new SqliteEventStore(file);
  const session = store.createSession(dir, {
    alias: 'local',
    provider: 'openai-compatible',
    model: 'test',
  });
  return {
    store,
    other,
    session,
    leases: new SessionLeases(store),
    close() {
      other.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('local work shares ownership and retains cross-process protection until its last release', () => {
  const f = fixture();
  const main = f.leases.retain(f.session.id, new AbortController());
  const background = f.leases.retain(f.session.id, new AbortController());
  try {
    assert.equal(main.owner, background.owner);
    main.release();
    main.release();
    assert.throws(() => f.other.deleteSession(f.session.id), /运行中的会话/);
    assert.throws(() => f.other.acquireLease(f.session.id, 'other', 30_000), /另一个进程/);
    const script = `
      import assert from 'node:assert/strict';
      import { SqliteEventStore } from ${JSON.stringify(new URL('../storage/event-store.js', import.meta.url).href)};
      const store = new SqliteEventStore(${JSON.stringify(path.join(f.session.workspace, 'db.sqlite'))});
      try {
        assert.throws(() => store.deleteSession(${JSON.stringify(f.session.id)}), /运行中的会话/);
        assert.throws(() => store.acquireLease(${JSON.stringify(f.session.id)}, 'external-process', 30_000), /另一个进程/);
      } finally { store.close(); }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
    const resumed = f.leases.retain(f.session.id, new AbortController());
    assert.equal(resumed.owner, main.owner);
    background.release();
    assert.equal(f.other.isLeased(f.session.id), true);
    resumed.release();
    f.other.acquireLease(f.session.id, 'other', 30_000);
    background.release();
    assert.equal(
      f.other.isLeased(f.session.id),
      true,
      'duplicate cleanup must not release another owner',
    );
    f.other.releaseLease(f.session.id, 'other');
    f.other.deleteSession(f.session.id);
  } finally {
    main.release();
    background.release();
    f.close();
  }
});

for (const failure of ['lost', 'storage-error'] as const) {
  test(`shared lease ${failure} cancels every holder and rejects new work until settlement`, (t) => {
    const f = fixture();
    t.mock.timers.enable({ apis: ['setInterval'] });
    const first = new AbortController();
    const second = new AbortController();
    const a = f.leases.retain(f.session.id, first);
    const b = f.leases.retain(f.session.id, second);
    try {
      t.mock.method(f.store, 'renewLease', () => {
        if (failure === 'storage-error') throw new Error('SQLITE_BUSY');
        return false;
      });
      t.mock.timers.tick(10_000);
      assert.equal(first.signal.aborted, true);
      assert.equal(second.signal.aborted, true);
      assert.throws(() => f.leases.retain(f.session.id, new AbortController()), /租约已失效/);
      a.release();
      assert.equal(f.store.isLeased(f.session.id), true);
      b.release();
      const recovered = f.leases.retain(f.session.id, new AbortController());
      assert.notEqual(recovered.owner, a.owner);
      recovered.release();
      assert.equal(f.store.isLeased(f.session.id), false);
    } finally {
      a.release();
      b.release();
      f.close();
    }
  });
}

test('failed acquisition and cancelled work never disturb existing ownership', () => {
  const f = fixture();
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    assert.throws(() => f.leases.retain(f.session.id, cancelled), /已取消/);
    assert.equal(f.store.isLeased(f.session.id), false);
    f.other.acquireLease(f.session.id, 'other', 30_000);
    assert.throws(() => f.leases.retain(f.session.id, new AbortController()), /另一个进程/);
    assert.equal(f.store.isLeased(f.session.id), true);
    f.other.releaseLease(f.session.id, 'other');
    const lease = f.leases.retain(f.session.id, new AbortController());
    assert.notEqual(lease.owner, 'other');
    lease.release();
  } finally {
    f.close();
  }
});

test('an observed takeover cancels existing work immediately and cleanup preserves the new owner', (t) => {
  const f = fixture();
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);
  const controller = new AbortController();
  const lease = f.leases.retain(f.session.id, controller);
  try {
    clock.mock.mockImplementation(() => now + 31_000);
    f.other.acquireLease(f.session.id, 'other', 30_000);
    assert.throws(() => f.leases.retain(f.session.id, new AbortController()), /另一个进程/);
    assert.equal(controller.signal.aborted, true);
    lease.release();
    assert.equal(f.other.isLeased(f.session.id), true);
    f.other.releaseLease(f.session.id, 'other');
  } finally {
    lease.release();
    f.close();
  }
});
