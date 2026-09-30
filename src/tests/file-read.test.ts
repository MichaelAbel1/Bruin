import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessExecutor } from '../executor/client.js';
import { readWorkspaceFile, writeWorkspaceFile } from '../core/workspace-files.js';

test('bounded UTF-8 reads preserve complete characters and reject malformed files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-file-read-'));
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
