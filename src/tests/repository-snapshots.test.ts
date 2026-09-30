import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ProcessExecutor } from '../executor/client.js';
import { createHash } from 'node:crypto';
import { searchRepository } from '../core/repository-index.js';
import { listSnapshots } from '../core/snapshots.js';
import { writeWorkspaceFile } from '../core/workspace-files.js';
import { decisionFor } from '../core/permissions.js';
import { planBlocks } from '../runtime/plan.js';
import type { ToolName } from '../core/types.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-capabilities-'));
  const old = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const executor = new ProcessExecutor();
  let count = 0;
  return {
    root,
    dir,
    run(name: ToolName, input: Record<string, unknown>) {
      return executor.execute({
        requestId: String(++count),
        name,
        input,
        workspace: root,
        timeoutMs: 5000,
        maxOutputBytes: 100_000,
      });
    },
    async close() {
      await executor.close();
      if (old === undefined) delete process.env.BRUIN_HOME;
      else process.env.BRUIN_HOME = old;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('repository index detects same-size edits, deletions, new files and git ignores', async () => {
  const f = fixture();
  try {
    execFileSync('git', ['init'], { cwd: f.root, stdio: 'ignore' });
    fs.writeFileSync(path.join(f.root, '.gitignore'), 'ignored.ts\n');
    const file = path.join(f.root, 'code.ts');
    fs.writeFileSync(file, 'export function alpha() {}\n');
    fs.writeFileSync(path.join(f.root, 'ignored.ts'), 'function secret() {}');
    assert.equal(searchRepository(f.root, 'alpha').results[0].symbols[0].line, 1);
    assert.equal(searchRepository(f.root, 'secret').results.length, 0);
    const stat = fs.statSync(file);
    fs.writeFileSync(file, 'export function bravo() {}\n');
    fs.utimesSync(file, stat.atime, stat.mtime);
    assert.equal(searchRepository(f.root, 'alpha').results.length, 0);
    assert.equal(searchRepository(f.root, 'bravo').results[0].symbols[0].name, 'bravo');
    fs.unlinkSync(file);
    assert.equal(searchRepository(f.root, 'bravo').results.length, 0);
    fs.writeFileSync(path.join(f.root, 'new.py'), 'def fresh():\n  pass\n');
    const result = await f.run('search_repository', { query: 'fresh' });
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.output).results[0].path, 'new.py');
  } finally {
    await f.close();
  }
});
test(
  'non-git repository index skips symlinks, binary files and excluded directories',
  { skip: process.platform === 'win32' },
  async () => {
    const f = fixture();
    try {
      fs.mkdirSync(path.join(f.root, 'node_modules'));
      fs.writeFileSync(path.join(f.root, 'node_modules', 'private.ts'), 'function dependency() {}');
      fs.writeFileSync(path.join(f.root, 'binary'), Buffer.from([0, 255]));
      fs.writeFileSync(path.join(f.dir, 'outside.ts'), 'function outside() {}');
      fs.symlinkSync(path.join(f.dir, 'outside.ts'), path.join(f.root, 'link.ts'));
      fs.writeFileSync(path.join(f.root, 'a.ts'), 'class Visible {}');
      const index = searchRepository(f.root, '');
      assert.equal(index.gitIgnore, false);
      assert.deepEqual(
        index.results.map((item) => item.path),
        ['a.ts'],
      );
    } finally {
      await f.close();
    }
  },
);
test('file writes and desktop saves make snapshots; restoring preserves bytes and mode', async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, 'script.txt');
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    fs.writeFileSync(file, original, { mode: 0o755 });
    assert.equal(
      (await f.run('write_file', { path: 'script.txt', content: 'changed' })).isError,
      false,
    );
    const snapshot = listSnapshots(f.root)[0];
    assert.equal(snapshot.path, 'script.txt');
    assert.equal((await f.run('restore_snapshot', { id: snapshot.id })).isError, false);
    assert.deepEqual(fs.readFileSync(file), original);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    writeWorkspaceFile(f.root, 'script.txt', 'desktop');
    assert.ok(listSnapshots(f.root).length >= 3);
    const page = JSON.parse((await f.run('list_snapshots', { limit: 1 })).output);
    assert.equal(page.snapshots.length, 1);
    assert.equal(page.nextOffset, 1);
    const next = JSON.parse(
      (await f.run('list_snapshots', { offset: page.nextOffset, limit: 1 })).output,
    );
    assert.notEqual(page.snapshots[0].id, next.snapshots[0].id);
    assert.throws(
      () => writeWorkspaceFile(f.root, 'script.txt', 'stale save', 'changed'),
      /后续修改/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'desktop');
    writeWorkspaceFile(f.root, 'script.txt', 'fresh save', 'desktop');
    assert.equal(fs.readFileSync(file, 'utf8'), 'fresh save');
  } finally {
    await f.close();
  }
});
test('rollback refuses external edits and cross-workspace ids and can undo a created file', async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, 'new.txt');
    await f.run('write_file', { path: 'new.txt', content: 'new' });
    const snapshot = listSnapshots(f.root)[0];
    assert.equal(snapshot.action, 'delete_created_file');
    fs.writeFileSync(file, 'external edit');
    const conflict = await f.run('restore_snapshot', { id: snapshot.id });
    assert.equal(conflict.isError, true);
    assert.match(conflict.output, /后续修改/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'external edit');
    const other = path.join(f.dir, 'other');
    fs.mkdirSync(other);
    assert.deepEqual(listSnapshots(other), []);
    fs.writeFileSync(file, 'new');
    assert.equal((await f.run('restore_snapshot', { id: snapshot.id })).isError, false);
    assert.equal(fs.existsSync(file), false);
    assert.equal((await f.run('restore_snapshot', { id: '../outside' })).isError, true);
    const call = { id: 'restore', name: 'restore_snapshot' as const, input: { id: snapshot.id } };
    assert.equal(decisionFor(call, f.root).decision, 'ask');
    assert.equal(
      planBlocks(call, { enabled: true, approved: false, steps: [], progress: {} }),
      true,
    );
  } finally {
    await f.close();
  }
});

test(
  'rollback rejects damaged snapshot content, path escapes and symlink targets',
  { skip: process.platform === 'win32' },
  async () => {
    const f = fixture();
    try {
      const target = path.join(f.root, 'file.txt');
      fs.writeFileSync(target, 'original');
      await f.run('write_file', { path: 'file.txt', content: 'after' });
      const snapshot = listSnapshots(f.root)[0];
      const key = createHash('sha256').update(fs.realpathSync(f.root)).digest('hex');
      const metadata = path.join(f.dir, 'home', 'snapshots', key, `${snapshot.id}.json`);
      const original = fs.readFileSync(metadata, 'utf8');
      const value = JSON.parse(original);
      value.before = Buffer.from('corrupted').toString('base64');
      fs.writeFileSync(metadata, JSON.stringify(value));
      assert.equal((await f.run('restore_snapshot', { id: snapshot.id })).isError, true);
      assert.equal(fs.readFileSync(target, 'utf8'), 'after');
      value.before = JSON.parse(original).before;
      value.path = '../outside.txt';
      fs.writeFileSync(metadata, JSON.stringify(value));
      assert.equal((await f.run('restore_snapshot', { id: snapshot.id })).isError, true);
      fs.writeFileSync(metadata, original);
      const outside = path.join(f.dir, 'outside.txt');
      fs.writeFileSync(outside, 'outside');
      fs.unlinkSync(target);
      fs.symlinkSync(outside, target);
      assert.equal((await f.run('restore_snapshot', { id: snapshot.id })).isError, true);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    } finally {
      await f.close();
    }
  },
);
