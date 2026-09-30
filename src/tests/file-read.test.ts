import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProcessExecutor } from '../executor/client.js';
import { readWorkspaceFile, writeWorkspaceFile } from '../core/workspace-files.js';

test(
  'desktop preview remains readable when Git hangs',
  { skip: process.platform === 'win32' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-git-timeout-'));
    const oldPath = process.env.PATH;
    try {
      fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\nexec /bin/sleep 20\n', { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'sample.txt'), 'working copy');
      process.env.PATH = dir;
      const started = Date.now();
      const preview = readWorkspaceFile(dir, 'sample.txt');
      assert.equal(preview.content, 'working copy');
      assert.equal(preview.baselineContent, undefined);
      assert.ok(Date.now() - started < 10_000, 'Git must not block until its natural exit');
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('bounded UTF-8 reads preserve complete characters and reject malformed files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-file-read-'));
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const executor = new ProcessExecutor();
  const read = (name: string, max: number) =>
    executor.execute({
      requestId: `${name}-${max}`,
      name: 'read_file',
      input: { path: name },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: max,
    });
  try {
    fs.writeFileSync(path.join(dir, 'unicode.txt'), '甲🙂乙');
    const cut = await read('unicode.txt', 5);
    assert.equal(cut.isError, false);
    assert.equal(cut.truncated, true);
    assert.equal(cut.output, '甲\n[输出已截断]');
    const full = await read('unicode.txt', 100);
    assert.equal(full.output, '甲🙂乙');
    assert.equal(full.truncated, false);
    fs.writeFileSync(path.join(dir, 'bom.txt'), '\uFEFF甲');
    assert.equal((await read('bom.txt', 100)).output, '\uFEFF甲');
    assert.equal(readWorkspaceFile(dir, 'bom.txt').content, '\uFEFF甲');
    const edited = await executor.execute({
      requestId: 'edit-bom',
      name: 'edit_file',
      input: { path: 'bom.txt', oldText: '甲', newText: '乙' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    assert.equal(edited.isError, false);
    assert.equal(fs.readFileSync(path.join(dir, 'bom.txt'), 'utf8'), '\uFEFF乙');
    fs.writeFileSync(path.join(dir, 'bad.txt'), Buffer.from([0x61, 0xff, 0x62]));
    const bad = await read('bad.txt', 100);
    assert.equal(bad.isError, true);
    assert.match(bad.output, /有效的 UTF-8/);
    fs.writeFileSync(path.join(dir, 'partial.txt'), Buffer.from([0x61, 0xe4]));
    assert.equal((await read('partial.txt', 100)).isError, true);
  } finally {
    await executor.close();
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop truncated previews cannot replace the full file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-preview-'));
  const target = path.join(dir, 'large.txt');
  const original = 'x'.repeat(256_001) + '\nTAIL MUST SURVIVE';
  try {
    fs.writeFileSync(target, original);
    const preview = readWorkspaceFile(dir, 'large.txt');
    assert.equal(preview.truncated, true);
    assert.throws(() => writeWorkspaceFile(dir, 'large.txt', preview.content + 'edit'), /截断预览/);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    fs.writeFileSync(target, 'small');
    const earlier = readWorkspaceFile(dir, 'large.txt');
    assert.equal(earlier.truncated, false);
    fs.writeFileSync(target, original);
    assert.throws(() => writeWorkspaceFile(dir, 'large.txt', earlier.content), /截断预览/);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop text previews reject invalid UTF-8 and omit partial boundary characters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-preview-'));
  const target = path.join(dir, 'sample.txt');
  try {
    fs.writeFileSync(target, 'x'.repeat(255_999) + '🙂tail');
    const preview = readWorkspaceFile(dir, 'sample.txt');
    assert.equal(preview.truncated, true);
    assert.equal(preview.content, 'x'.repeat(255_999));
    fs.writeFileSync(target, Buffer.from([0x61, 0xff]));
    assert.throws(() => readWorkspaceFile(dir, 'sample.txt'), /有效的 UTF-8/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop previews continue after short reads and still detect truncation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-preview-short-read-'));
  try {
    fs.writeFileSync(path.join(dir, 'small.txt'), '甲🙂乙');
    fs.writeFileSync(path.join(dir, 'large.txt'), 'x'.repeat(256_001));
    const module = new URL('../core/workspace-files.js', import.meta.url).href;
    const script = `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      const { readWorkspaceFile } = await import(${JSON.stringify(module)});
      const read = fs.readSync;
      fs.readSync = (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(2, length), position);
      const small = readWorkspaceFile(${JSON.stringify(dir)}, 'small.txt');
      assert.equal(small.content, '甲🙂乙');
      assert.equal(small.truncated, false);
      const large = readWorkspaceFile(${JSON.stringify(dir)}, 'large.txt');
      assert.equal(large.content.length, 256_000);
      assert.equal(large.truncated, true);
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop git baselines resolve from a workspace inside the repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-preview-git-'));
  const workspace = path.join(dir, 'nested');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  try {
    git('init');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.com');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(dir, 'sample.txt'), 'root baseline');
    fs.writeFileSync(path.join(workspace, 'sample.txt'), 'nested baseline');
    git('add', '.');
    git('commit', '-m', 'initial');
    fs.writeFileSync(path.join(workspace, 'sample.txt'), 'edited nested file');
    const preview = readWorkspaceFile(workspace, 'sample.txt');
    assert.equal(preview.content, 'edited nested file');
    assert.equal(preview.baselineContent, 'nested baseline');
    assert.equal(readWorkspaceFile(dir, 'nested/sample.txt').baselineContent, 'nested baseline');
    assert.equal(
      readWorkspaceFile(workspace, '../nested/sample.txt').baselineContent,
      'nested baseline',
    );
    fs.writeFileSync(path.join(workspace, 'untracked.txt'), 'new');
    assert.equal(readWorkspaceFile(workspace, 'untracked.txt').baselineContent, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file tools continue after short reads rather than returning an incomplete file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-short-read-'));
  try {
    fs.writeFileSync(path.join(dir, 'sample.txt'), '甲🙂乙');
    const worker = new URL('../executor/worker.js', import.meta.url).href;
    const script = `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      await import(${JSON.stringify(worker)});
      const read = fs.readSync;
      fs.readSync = (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(2, length), position);
      process.connected = true;
      let replied = false;
      process.on('beforeExit', () => assert.equal(replied, true));
      process.send = ({ result }) => {
        replied = true;
        assert.equal(result.isError, false);
        assert.equal(result.output, '甲🙂乙');
        assert.equal(result.truncated, false);
      };
      process.emit('message', { requestId: 'short-read', name: 'read_file', input: { path: 'sample.txt' }, workspace: ${JSON.stringify(dir)}, timeoutMs: 5000, maxOutputBytes: 100 });
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file enforces the actual read limit when a file grows after stat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-growing-edit-'));
  const file = path.join(dir, 'growing.txt');
  try {
    fs.writeFileSync(file, 'old');
    const worker = new URL('../executor/worker.js', import.meta.url).href;
    const script = `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      await import(${JSON.stringify(worker)});
      const file = ${JSON.stringify(file)};
      const read = fs.readSync;
      let grown = false;
      fs.readSync = (...args) => {
        if (!grown) { grown = true; fs.writeFileSync(file, 'old' + 'x'.repeat(5_000_000)); }
        return read(...args);
      };
      process.connected = true;
      let replied = false;
      process.on('beforeExit', () => assert.equal(replied, true));
      process.send = ({ result }) => {
        replied = true;
        assert.equal(grown, true);
        assert.equal(result.isError, true);
        assert.match(result.output, /文件过大/);
        assert.equal(fs.statSync(file).size, 5_000_003);
        assert.equal(fs.readFileSync(file, 'utf8').startsWith('old'), true);
      };
      process.emit('message', { requestId: 'grow', name: 'edit_file', input: { path: 'growing.txt', oldText: 'old', newText: 'new' }, workspace: ${JSON.stringify(dir)}, timeoutMs: 5000, maxOutputBytes: 100 });
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
