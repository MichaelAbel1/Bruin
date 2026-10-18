import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteEventStore } from '../storage/event-store.js';
import { acquireDatabaseMaintenance } from '../storage/database-access.js';
import { createBackup, previewBackup, restoreBackup } from '../storage/backup.js';
import { doctor } from '../runtime/doctor.js';

test('backup is verified, restore needs confirmation, retains old data and cannot replay in-flight work', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-backup-'));
  const home = path.join(fs.realpathSync(base), 'home');
  const archive = path.join(fs.realpathSync(base), 'backup');
  const file = path.join(home, 'sessions.sqlite');
  let store = new SqliteEventStore(file);
  const workspace = path.join(home, 'workspaces', 'project');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'source.ts'), 'original source');
  fs.mkdirSync(path.join(workspace, 'empty'));
  const session = store.createManagedSession(workspace, {
    alias: 'test',
    provider: 'openai',
    model: 'mock',
  });
  const job = store.createCronJob(session.id, '* * * * *', 'check');
  store.takeDueCronJobs(job.nextRunAt);
  store.saveMemory(workspace, 'rules', 'original memory');
  const task = store.createTask(session.id, 'test task', []);
  store.claimTask(session.id, 'crashed-process', 30_000);
  try {
    await assert.rejects(createBackup(home, archive), /正在使用或维护/);
    store.close();
    await createBackup(home, archive);
    await assert.rejects(createBackup(home, archive), /已存在/);
    const preview = await previewBackup(archive);
    assert.equal(preview.schemaVersion, 8);
    assert.equal(preview.externalWorkspaces.length, 0);
    await assert.rejects(restoreBackup(home, archive, ''), /confirmation/);
    await assert.rejects(
      restoreBackup(path.join(base, 'elsewhere'), archive, preview.confirmation),
      /原 BRUIN_HOME/,
    );
    store = new SqliteEventStore(file);
    store.saveMemory(workspace, 'rules', 'new memory');
    await assert.rejects(restoreBackup(home, archive, preview.confirmation), /正在使用或维护/);
    store.close();
    const restored = await restoreBackup(home, archive, preview.confirmation);
    assert.ok(restored.previous && fs.existsSync(restored.previous));
    store = new SqliteEventStore(file);
    assert.equal(store.listMemory(workspace)[0].content, 'original memory');
    assert.equal(store.getTask(session.id, task.id)?.status, 'unknown');
    assert.equal(store.listCronJobs(session.id)[0].lastStatus, 'needs_review');
    assert.equal(store.isLeased(session.id), false);
    assert.equal(fs.readFileSync(path.join(workspace, 'source.ts'), 'utf8'), 'original source');
    assert.equal(fs.existsSync(path.join(workspace, 'empty')), true);
    const previous = new SqliteEventStore(path.join(restored.previous!, 'sessions.sqlite'));
    try {
      assert.equal(previous.listMemory(workspace)[0].content, 'new memory');
    } finally {
      previous.close();
    }
  } finally {
    store.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('tampered files, path traversal, unexpected WAL and symlinks fail before replacing any data', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-backup-invalid-')));
  const home = path.join(base, 'home');
  const archive = path.join(base, 'backup');
  const store = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
  store.createSession(base, { alias: 'test', provider: 'openai', model: 'mock' });
  store.close();
  try {
    await createBackup(home, archive);
    const preview = await previewBackup(archive);
    assert.deepEqual(preview.externalWorkspaces, [base]);
    const manifestFile = path.join(archive, 'manifest.json');
    const original = fs.readFileSync(manifestFile, 'utf8');
    const manifest = JSON.parse(original);
    manifest.files[0].path = '../escape';
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    await assert.rejects(previewBackup(archive), /无效备份路径/);
    fs.writeFileSync(manifestFile, original);
    fs.writeFileSync(path.join(archive, 'data', 'sessions.sqlite-wal'), 'unexpected');
    await assert.rejects(restoreBackup(home, archive, preview.confirmation), /清单之外/);
    fs.unlinkSync(path.join(archive, 'data', 'sessions.sqlite-wal'));
    fs.appendFileSync(path.join(archive, 'data', 'sessions.sqlite'), 'tampered');
    await assert.rejects(restoreBackup(home, archive, preview.confirmation), /校验失败/);
    const intact = new Database(path.join(home, 'sessions.sqlite'), { readonly: true });
    try {
      assert.equal(intact.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      intact.close();
    }
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(home, 'sessions.sqlite'), path.join(home, 'AGENTS.md'));
      await assert.rejects(createBackup(home, path.join(base, 'unsafe')), /符号链接/);
      assert.equal(fs.existsSync(path.join(base, 'unsafe')), false);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('database access guards multiple readers and releases after failed construction', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-db-access-'));
  const file = path.join(base, 'sessions.sqlite');
  const one = new SqliteEventStore(file);
  const two = new SqliteEventStore(file);
  try {
    one.close();
    assert.throws(() => acquireDatabaseMaintenance(file), /正在使用或维护/);
    two.close();
    const release = acquireDatabaseMaintenance(file);
    try {
      assert.throws(() => new SqliteEventStore(file), /正在使用或维护/);
    } finally {
      release();
    }
    const db = new Database(file);
    db.pragma('user_version = 999');
    db.close();
    assert.throws(() => new SqliteEventStore(file), /高于当前支持/);
    acquireDatabaseMaintenance(file)();
  } finally {
    one.close();
    two.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('restore preserves the current directory if the final rename fails and refuses unmanaged worktree loss', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-restore-rollback-')));
  const home = path.join(base, 'home');
  const archive = path.join(base, 'backup');
  const store = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
  store.close();
  try {
    await createBackup(home, archive);
    const preview = await previewBackup(archive);
    fs.writeFileSync(path.join(home, 'current-only.txt'), 'must survive');
    fs.mkdirSync(path.join(home, 'worktrees'));
    fs.writeFileSync(path.join(home, 'worktrees', 'current.txt'), 'uncommitted');
    await assert.rejects(restoreBackup(home, archive, preview.confirmation), /托管 Git worktrees/);
    fs.rmSync(path.join(home, 'worktrees'), { recursive: true });
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
      if (String(source).startsWith(home + '.restore-') && target === home)
        throw new Error('injected rename failure');
      return rename(source, target);
    });
    await assert.rejects(
      restoreBackup(home, archive, preview.confirmation),
      /injected rename failure/,
    );
    assert.equal(fs.readFileSync(path.join(home, 'current-only.txt'), 'utf8'), 'must survive');
    const reopened = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
    reopened.close();
  } finally {
    t.mock.restoreAll();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('doctor does not migrate or expose legacy credentials', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-doctor-'));
  const old = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = base;
  const raw = JSON.stringify({
    profiles: [
      { alias: 'test', provider: 'openai', model: 'mock', apiKeyEnv: 'sk-SECRET-DO-NOT-PRINT' },
    ],
  });
  fs.writeFileSync(path.join(base, 'config.json'), raw);
  try {
    const result = doctor();
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.equal(fs.readFileSync(path.join(base, 'config.json'), 'utf8'), raw);
    assert.equal(fs.existsSync(path.join(base, 'sessions.sqlite')), false);
  } finally {
    if (old === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = old;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
