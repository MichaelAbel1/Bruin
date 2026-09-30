import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProcessExecutor } from '../executor/client.js';
import { decisionFor } from '../core/permissions.js';
import { planBlocks } from '../runtime/plan.js';
import { toolSchemas } from '../providers/gateway.js';
import type { ToolName } from '../core/types.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-explore-'));
  const executor = new ProcessExecutor();
  let id = 0;
  return {
    dir,
    execute(name: ToolName, input: Record<string, unknown>, maxOutputBytes = 100_000) {
      return executor.execute({
        requestId: String(++id),
        name,
        input,
        workspace: dir,
        timeoutMs: 5000,
        maxOutputBytes,
      });
    },
    async close() {
      await executor.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('search fallback reports omitted matches and preserves complete UTF-8 output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-search-fallback-'));
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  const executor = new ProcessExecutor();
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  let id = 0;
  const search = (maxOutputBytes: number) =>
    executor.execute({
      requestId: String(++id),
      name: 'search',
      input: { pattern: '甲' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes,
    });
  try {
    const file = path.join(dir, 'sample.txt');
    fs.writeFileSync(file, '甲\n'.repeat(101));
    const limited = await search(100_000);
    assert.equal(limited.isError, false, limited.output);
    assert.equal(limited.truncated, true);
    assert.match(limited.output, /输出已截断/);
    fs.writeFileSync(file, '甲');
    const cut = await search(Buffer.byteLength('sample.txt:1:') + 1);
    assert.equal(cut.isError, false, cut.output);
    assert.equal(cut.truncated, true);
    assert.equal(cut.output.includes('\uFFFD'), false);
    fs.writeFileSync(file, '甲\n'.repeat(100));
    assert.equal((await search(100_000)).truncated, false);
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search fallback handles cancellation, timeouts and stream read errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-search-interruption-'));
  try {
    fs.writeFileSync(path.join(dir, 'sample.txt'), 'hello');
    const worker = new URL('../executor/worker.js', import.meta.url).href;
    for (const mode of ['cancel', 'timeout', 'read-error']) {
      const script = `
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        import { PassThrough } from 'node:stream';
        process.env.PATH = ${JSON.stringify(dir)};
        await import(${JSON.stringify(worker)});
        let stream;
        fs.createReadStream = (_path, options) => {
          stream = new PassThrough();
          if (options?.fd !== undefined) stream.once('close', () => fs.closeSync(options.fd));
          if (${JSON.stringify(mode)} === 'cancel') setImmediate(() => process.emit('message', { type: 'cancel', requestId: 'search' }));
          if (${JSON.stringify(mode)} === 'read-error') setImmediate(() => stream.destroy(new Error('模拟读取失败')));
          return stream;
        };
        const guard = setTimeout(() => { throw new Error('搜索没有响应取消或超时'); }, 1000);
        process.connected = true;
        process.send = ({result}) => {
          clearTimeout(guard);
          assert.equal(result.isError, ${mode !== 'read-error'});
          ${mode === 'read-error' ? "assert.equal(result.output, '');" : `assert.match(result.output, ${mode === 'cancel' ? '/取消/' : '/超时/'});`}
          assert.equal(stream.destroyed, true);
        };
        process.emit('message', { requestId: 'search', name: 'search', input: { pattern: 'hello' }, workspace: ${JSON.stringify(dir)}, timeoutMs: 50, maxOutputBytes: 100 });
      `;
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 3000 });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'search fallback reads the checked file descriptor instead of reopening a replaced path',
  { skip: process.platform === 'win32' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-search-race-'));
    const root = path.join(dir, 'workspace');
    fs.mkdirSync(root);
    const file = path.join(root, 'sample.txt');
    const outside = path.join(dir, 'outside.txt');
    try {
      fs.writeFileSync(file, 'hello original');
      fs.writeFileSync(outside, 'hello outside secret');
      const worker = new URL('../executor/worker.js', import.meta.url).href;
      const script = `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      process.env.PATH = ${JSON.stringify(dir)};
      await import(${JSON.stringify(worker)});
      const create = fs.createReadStream;
      fs.createReadStream = (...args) => {
        fs.unlinkSync(${JSON.stringify(file)});
        fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(file)});
        return create(...args);
      };
      let replied = false;
      process.connected = true;
      process.on('beforeExit', () => assert.equal(replied, true));
      process.send = ({result}) => {
        replied = true;
        assert.equal(result.isError, false, result.output);
        assert.match(result.output, /hello original/);
        assert.equal(result.output.includes('outside secret'), false);
      };
      process.emit('message', { requestId: 'search', name: 'search', input: { pattern: 'hello' }, workspace: ${JSON.stringify(root)}, timeoutMs: 1000, maxOutputBytes: 100 });
    `;
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 3000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('read_file pages preserve line endings and can reach content after the old byte limit', async () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, 'sample.txt');
    fs.writeFileSync(file, '\uFEFFone\r\n二🙂\r\n\r\nlast');
    const page = await f.execute('read_file', { path: 'sample.txt', startLine: 2, lineCount: 2 });
    assert.equal(page.isError, false);
    assert.equal(page.output, '二🙂\r\n\r\n\n[行范围：2-3；后续内容请使用 startLine=4]');
    assert.equal(page.truncated, true);
    const tail = await f.execute('read_file', { path: 'sample.txt', startLine: 4 });
    assert.equal(tail.output, 'last\n[行范围：4-4；已到文件末尾]');
    assert.equal(tail.truncated, false);
    assert.match(
      (await f.execute('read_file', { path: 'sample.txt', startLine: 5 })).output,
      /超出文件范围/,
    );
    assert.equal(
      (await f.execute('read_file', { path: 'sample.txt' })).output,
      '\uFEFFone\r\n二🙂\r\n\r\nlast',
    );
    fs.writeFileSync(file, 'x\n'.repeat(60_000) + 'TARGET');
    assert.match(
      (await f.execute('read_file', { path: 'sample.txt', startLine: 60_001 })).output,
      /^TARGET\n/,
    );
    fs.writeFileSync(file, '');
    assert.match(
      (await f.execute('read_file', { path: 'sample.txt', lineCount: 1 })).output,
      /文件为空/,
    );
    fs.writeFileSync(file, 'one\n');
    assert.equal(
      (await f.execute('read_file', { path: 'sample.txt', lineCount: 1 })).truncated,
      false,
    );
  } finally {
    await f.close();
  }
});

test('file pages bound long lines, preserve UTF-8 boundaries, and reject invalid inputs', async () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, 'sample.txt');
    fs.writeFileSync(file, '甲🙂乙\nnext');
    const cut = await f.execute('read_file', { path: 'sample.txt', startLine: 1 }, 5);
    assert.equal(cut.isError, false);
    assert.equal(cut.truncated, true);
    assert.match(cut.output, /^甲\n/);
    assert.match(cut.output, /第 1 行未完整输出/);
    assert.equal(cut.output.includes('\uFFFD'), false);
    fs.writeFileSync(file, Buffer.from([0xff, 10]));
    assert.equal(
      (await f.execute('read_file', { path: 'sample.txt', lineCount: 1 })).isError,
      true,
    );
    for (const input of [
      { startLine: 0 },
      { startLine: 1.5 },
      { lineCount: -1 },
      { lineCount: '2' },
    ]) {
      assert.equal((await f.execute('read_file', { path: 'sample.txt', ...input })).isError, true);
      assert.equal(
        toolSchemas.read_file.inputSchema.safeParse({ path: 'sample.txt', ...input }).success,
        false,
      );
    }
    assert.equal(
      (await f.execute('read_file', { path: '../outside', startLine: 1 })).isError,
      true,
    );
  } finally {
    await f.close();
  }
});

test('list_files discovers directories and pages beyond 300 entries within its byte budget', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.dir, 'nested'));
    fs.writeFileSync(path.join(f.dir, 'nested', 'inside.txt'), 'inside');
    fs.writeFileSync(path.join(f.dir, '.hidden'), 'hidden');
    for (let i = 0; i < 305; i++) fs.writeFileSync(path.join(f.dir, `中${i}.txt`), '');
    const names = new Set<string>();
    let offset = 0;
    let first = true;
    while (true) {
      const result = await f.execute('list_files', { offset, limit: 100 }, 1000);
      assert.equal(result.isError, false);
      assert.ok(Buffer.byteLength(result.output) <= 1000);
      const page = JSON.parse(result.output);
      if (first) assert.equal(page.entries[0].kind, 'directory');
      first = false;
      for (const entry of page.entries) {
        assert.equal(names.has(entry.name), false);
        names.add(entry.name);
      }
      assert.equal(result.truncated, page.hasMore);
      if (!page.hasMore) {
        assert.equal(page.nextOffset, null);
        break;
      }
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(names.size, 307);
    assert.equal(names.has('.hidden'), true);
    const nested = JSON.parse((await f.execute('list_files', { path: 'nested' })).output);
    assert.equal(nested.entries[0].path, path.join('nested', 'inside.txt'));
    const empty = JSON.parse((await f.execute('list_files', { offset: 1000 })).output);
    assert.deepEqual(empty.entries, []);
    assert.equal(empty.hasMore, false);
  } finally {
    await f.close();
  }
});

test('directory discovery uses read-only planning policy and rejects escapes and non-directories', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dir, 'file.txt'), 'text');
    const call = { id: 'list', name: 'list_files' as const, input: {} };
    assert.equal(decisionFor(call, f.dir).decision, 'allow');
    assert.equal(
      planBlocks(call, { enabled: true, steps: [], approved: false, progress: {} }),
      false,
    );
    for (const input of [{ path: '..' }, { path: 'file.txt' }, { path: '' }]) {
      assert.equal(decisionFor({ ...call, input }, f.dir).decision, 'deny');
      assert.equal((await f.execute('list_files', input)).isError, true);
    }
    for (const input of [{ limit: 0 }, { offset: -1 }, { limit: 301 }, { offset: 0.5 }]) {
      assert.equal((await f.execute('list_files', input)).isError, true);
      assert.equal(toolSchemas.list_files.inputSchema.safeParse(input).success, false);
    }
    assert.equal((await f.execute('list_files', {}, 1)).isError, true);
  } finally {
    await f.close();
  }
});

test(
  'directory and paged file tools reject symlink paths and omit symlink entries',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    const f = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-explore-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
      fs.symlinkSync(outside, path.join(f.dir, 'link'));
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(f.dir, 'secret-link'));
      const listing = JSON.parse((await f.execute('list_files', {})).output);
      assert.deepEqual(listing.entries, []);
      assert.equal((await f.execute('list_files', { path: 'link' })).isError, true);
      assert.equal(
        decisionFor({ id: 'link', name: 'list_files', input: { path: 'link' } }, f.dir).decision,
        'deny',
      );
      assert.equal(
        (await f.execute('read_file', { path: 'secret-link', startLine: 1 })).isError,
        true,
      );
    } finally {
      await f.close();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  },
);
