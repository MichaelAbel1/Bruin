import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { importAttachments, loadAttachment } from '../core/attachments.js';

const session = '00000000-0000-0000-0000-000000000000';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-attachment-'));
  const previous = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  return {
    dir,
    root: path.join(process.env.BRUIN_HOME, 'attachments', session),
    close() {
      if (previous === undefined) delete process.env.BRUIN_HOME;
      else process.env.BRUIN_HOME = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('attachment extraction reports truncation and preserves complete Unicode characters', () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, 'large.txt');
    fs.writeFileSync(file, 'x'.repeat(59_999) + '🙂' + 'MISSING TAIL');
    const [ref] = importAttachments(session, [file]);
    assert.match(ref.note!, /已截断/);
    const loaded = loadAttachment(session, ref.id);
    assert.equal(loaded.text, 'x'.repeat(59_999));
    assert.equal(loaded.ref.note, ref.note);
    assert.equal(fs.readFileSync(path.join(f.root, ref.id), 'utf8').endsWith('MISSING TAIL'), true);
    fs.writeFileSync(file, 'x'.repeat(60_000));
    const [complete] = importAttachments(session, [file]);
    assert.equal(complete.note, undefined);
    assert.equal(loadAttachment(session, complete.id).text.length, 60_000);
  } finally {
    f.close();
  }
});

test('document extractors propagate truncation notes alongside format-specific limitations', () => {
  const f = fixture();
  const originalExec = childProcess.execFileSync;
  try {
    const text = '中'.repeat(60_001);
    childProcess.execFileSync = ((command: string, args: string[]) => {
      if (command === 'pdftotext') return text;
      if (args[2] === 'word/document.xml') return `<w:p><w:t>${text}</w:t></w:p>`;
      if (args[2] === 'xl/sharedStrings.xml') return '';
      if (args[2] === 'xl/worksheets/sheet1.xml')
        return `<row><c t="inlineStr"><is><t>${text}</t></is></c></row>`;
      throw new Error('unexpected extraction command');
    }) as typeof childProcess.execFileSync;
    syncBuiltinESMExports();
    for (const extension of ['docx', 'xlsx', 'pdf']) {
      const file = path.join(f.dir, `large.${extension}`);
      fs.writeFileSync(file, 'mock document');
      const [ref] = importAttachments(session, [file]);
      assert.match(ref.note!, /已截断/);
      if (extension === 'xlsx') assert.match(ref.note!, /仅提取第一个工作表/);
      const loaded = loadAttachment(session, ref.id);
      assert.equal(loaded.text, '中'.repeat(60_000));
      assert.equal(loaded.ref.note, ref.note);
    }
  } finally {
    childProcess.execFileSync = originalExec;
    syncBuiltinESMExports();
    f.close();
  }
});

test('attachment batch checks actual copied size after preflight and rolls back only its own files', () => {
  const f = fixture();
  const originalOpen = fs.openSync;
  try {
    const files = Array.from({ length: 5 }, (_, i) => path.join(f.dir, `${i}.txt`));
    for (const file of files) fs.writeFileSync(file, Buffer.alloc(4_000_000, 0x61));
    fs.mkdirSync(f.root, { recursive: true });
    fs.writeFileSync(path.join(f.root, 'existing'), 'keep');
    let changed = false;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === files[0] && !changed) {
        changed = true;
        fs.appendFileSync(files[4], 'x');
      }
      return originalOpen(...args);
    }) as typeof fs.openSync;
    assert.throws(() => importAttachments(session, files), /总量不能超过 20 MB/);
    assert.equal(changed, true);
    assert.deepEqual(fs.readdirSync(f.root), ['existing']);
    assert.equal(fs.readFileSync(path.join(f.root, 'existing'), 'utf8'), 'keep');
  } finally {
    fs.openSync = originalOpen;
    f.close();
  }
});

test('attachment import detects a file growing while it is being read', () => {
  const f = fixture();
  const originalRead = fs.readSync;
  try {
    const file = path.join(f.dir, 'growing.txt');
    fs.writeFileSync(file, 'small');
    let changed = false;
    fs.readSync = ((...args: unknown[]) => {
      if (!changed) {
        changed = true;
        fs.writeFileSync(file, Buffer.alloc(5_000_001, 0x61));
      }
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readSync;
    assert.throws(() => importAttachments(session, [file]), /超过 5 MB/);
    assert.equal(changed, true);
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally {
    fs.readSync = originalRead;
    f.close();
  }
});

test(
  'attachments replaced with FIFOs do not block import or image loading',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const f = fixture();
    try {
      const module = new URL('../core/attachments.js', import.meta.url).href;
      const script = `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { importAttachments, loadAttachment } from ${JSON.stringify(module)};
      const file = ${JSON.stringify(path.join(f.dir, 'source.png'))};
      fs.writeFileSync(file, 'image');
      const [ref] = importAttachments(${JSON.stringify(session)}, [file]);
      const image = ${JSON.stringify(f.root)} + '/' + ref.id;
      fs.unlinkSync(image);
      execFileSync('mkfifo', [image]);
      assert.throws(() => loadAttachment(${JSON.stringify(session)}, ref.id), /不是普通文件/);
      const open = fs.openSync;
      let replaced = false;
      fs.openSync = (...args) => {
        if (args[0] === file && !replaced) {
          replaced = true;
          fs.unlinkSync(file);
          execFileSync('mkfifo', [file]);
        }
        return open(...args);
      };
      assert.throws(() => importAttachments(${JSON.stringify(session)}, [file]), /不是普通文件/);
      assert.equal(replaced, true);
    `;
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
    } finally {
      f.close();
    }
  },
);
