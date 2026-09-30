import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installLocal, readSkill } from '../skills/registry.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-skill-install-'));
  const previous = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  const manifest = path.join(source, 'SKILL.md');
  const text = (body: string) => `---\nname: sample\ndescription: sample\n---\n${body}`;
  fs.writeFileSync(manifest, text('original'));
  const installed = installLocal(source);
  fs.writeFileSync(manifest, text('updated'));
  fs.writeFileSync(path.join(source, 'payload.bin'), Buffer.from([0, 255, 1]));
  return {
    dir,
    source,
    manifest,
    text,
    installed,
    root: path.dirname(installed.path),
    close() {
      if (previous === undefined) delete process.env.BRUIN_HOME;
      else process.env.BRUIN_HOME = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const replacement of ['growth', 'symlink', 'ancestor-symlink'] as const) {
  test(
    `skill copy rejects source ${replacement} after preflight and preserves installed files`,
    { skip: replacement !== 'growth' && process.platform === 'win32' },
    (t) => {
      const f = fixture();
      if (replacement === 'ancestor-symlink') {
        fs.mkdirSync(path.join(f.source, 'nested'));
        fs.writeFileSync(path.join(f.source, 'nested', 'private.bin'), 'source');
      }
      let changed = false;
      const mkdir = fs.mkdirSync;
      const mock = t.mock.method(fs, 'mkdirSync', (...args: Parameters<typeof fs.mkdirSync>) => {
        if (
          !changed &&
          path.basename(String(args[0])).startsWith('.stage-') &&
          fs.existsSync(args[0])
        ) {
          changed = true;
          const file = path.join(f.source, 'payload.bin');
          if (replacement === 'growth') fs.writeFileSync(file, Buffer.alloc(25 * 1024 * 1024));
          else if (replacement === 'symlink') {
            const external = path.join(f.dir, 'external');
            fs.writeFileSync(external, 'outside private data');
            fs.unlinkSync(file);
            fs.symlinkSync(external, file);
          } else {
            const external = path.join(f.dir, 'external-directory');
            fs.mkdirSync(external);
            fs.writeFileSync(path.join(external, 'private.bin'), 'outside data');
            const nested = path.join(f.source, 'nested');
            fs.rmSync(nested, { recursive: true });
            fs.symlinkSync(external, nested);
          }
        }
        return Reflect.apply(mkdir, fs, args);
      });
      try {
        assert.throws(() => installLocal(f.source), /过大|大小限制|符号链接/);
        assert.equal(changed, true);
        assert.match(readSkill('sample'), /original/);
        assert.deepEqual(fs.readdirSync(f.root), ['sample']);
      } finally {
        mock.mock.restore();
        f.close();
      }
    },
  );
}

for (const failure of ['metadata', 'publish'] as const) {
  test(`skill ${failure} failure removes its stage and restores the original installation`, (t) => {
    const f = fixture();
    const write = fs.writeFileSync;
    const rename = fs.renameSync;
    const mock =
      failure === 'metadata'
        ? t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
            if (
              String(args[0]).includes('.stage-') &&
              path.basename(String(args[0])) === '.bruin-source.json'
            )
              throw new Error('simulated metadata write failure');
            return Reflect.apply(write, fs, args);
          })
        : t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
            if (String(args[0]).includes('.stage-') && args[1] === f.installed.path)
              throw new Error('simulated publish failure');
            return Reflect.apply(rename, fs, args);
          });
    try {
      assert.throws(() => installLocal(f.source), /simulated/);
      assert.match(readSkill('sample'), /original/);
      assert.deepEqual(fs.readdirSync(f.root), ['sample']);
    } finally {
      mock.mock.restore();
      f.close();
    }
  });
}

test('a local skill revision describes the copied manifest rather than an earlier source read', (t) => {
  const f = fixture();
  const mkdir = fs.mkdirSync;
  let changed = false;
  const mock = t.mock.method(fs, 'mkdirSync', (...args: Parameters<typeof fs.mkdirSync>) => {
    if (
      !changed &&
      path.basename(String(args[0])).startsWith('.stage-') &&
      fs.existsSync(args[0])
    ) {
      changed = true;
      fs.writeFileSync(f.manifest, f.text('copied version'));
    }
    return Reflect.apply(mkdir, fs, args);
  });
  try {
    const installed = installLocal(f.source);
    assert.equal(changed, true);
    assert.equal(
      installed.revision,
      createHash('sha256')
        .update(fs.readFileSync(path.join(installed.path, 'SKILL.md')))
        .digest('hex'),
    );
    assert.match(readSkill('sample'), /copied version/);
    assert.deepEqual(
      fs.readFileSync(path.join(installed.path, 'payload.bin')),
      Buffer.from([0, 255, 1]),
    );
  } finally {
    mock.mock.restore();
    f.close();
  }
});

test('staging cleanup failures preserve the installation error and report the residual directory', (t) => {
  const f = fixture();
  const write = fs.writeFileSync;
  const rm = fs.rmSync;
  const writeMock = t.mock.method(
    fs,
    'writeFileSync',
    (...args: Parameters<typeof fs.writeFileSync>) => {
      if (
        String(args[0]).includes('.stage-') &&
        path.basename(String(args[0])) === '.bruin-source.json'
      )
        throw new Error('metadata failed');
      return Reflect.apply(write, fs, args);
    },
  );
  const cleanupMock = t.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
    if (path.basename(String(args[0])).startsWith('.stage-')) throw new Error('cleanup failed');
    return Reflect.apply(rm, fs, args);
  });
  try {
    assert.throws(
      () => installLocal(f.source),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /暂存目录清理失败/);
        assert.deepEqual(
          error.errors.map((item: Error) => item.message),
          ['metadata failed', 'cleanup failed'],
        );
        return true;
      },
    );
    assert.match(readSkill('sample'), /original/);
    assert.equal(
      fs.readdirSync(f.root).some((name) => name.startsWith('.stage-')),
      true,
    );
  } finally {
    writeMock.mock.restore();
    cleanupMock.mock.restore();
    f.close();
  }
});

test('old snapshot cleanup failure reports the committed installation without rolling it back', (t) => {
  const f = fixture();
  const rm = fs.rmSync;
  const mock = t.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
    if (path.basename(String(args[0])).startsWith('.old-'))
      throw new Error('simulated cleanup failure');
    return Reflect.apply(rm, fs, args);
  });
  try {
    assert.throws(() => installLocal(f.source), /已安装.*清理失败/);
    assert.match(readSkill('sample'), /updated/);
    assert.equal(
      fs.readdirSync(f.root).some((name) => name.startsWith('.stage-')),
      false,
    );
    assert.equal(
      fs.readdirSync(f.root).some((name) => name.startsWith('.old-')),
      true,
    );
  } finally {
    mock.mock.restore();
    f.close();
  }
});
