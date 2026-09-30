import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  installSnapshot,
  listSkills,
  loadSkill,
  readSkill,
  setSkillEnabled,
  uninstallSkill,
  installLocal,
} from '../skills/registry.js';

test('bundled skills load on demand and can be disabled without uninstalling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-builtin-test-'));
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  try {
    const builtins = listSkills().filter((skill) => skill.source.startsWith('builtin:'));
    assert.deepEqual(
      builtins.map((skill) => skill.name),
      ['code-review', 'debug', 'plan', 'test'],
    );
    assert.ok(builtins.every((skill) => skill.enabled));
    assert.match(loadSkill('debug'), /调试故障/);
    setSkillEnabled('debug', false);
    assert.throws(() => loadSkill('debug'), /未启用/);
    assert.equal(listSkills().find((skill) => skill.name === 'debug')?.enabled, false);
    assert.throws(() => uninstallSkill('debug'), /不能卸载/);
  } finally {
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skill manifests reject oversized text and invalid UTF-8 before installation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-skill-bounds-'));
  const previous = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  try {
    const source = path.join(dir, 'source');
    fs.mkdirSync(source);
    const file = path.join(source, 'SKILL.md');
    for (const contents of [
      Buffer.from('---\nname: sample\ndescription: sample\n---\n' + 'x'.repeat(100_000)),
      Buffer.from([0xff]),
    ]) {
      fs.writeFileSync(file, contents);
      assert.throws(() => installLocal(source), /过大|UTF-8/);
    }
    assert.equal(
      listSkills().some((skill) => skill.name === 'sample'),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skill discovery skips malformed source metadata rather than enabling it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-skill-metadata-'));
  const previous = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  try {
    const info = installSnapshot(
      [{ path: 'SKILL.md', contents: '---\nname: sample\ndescription: sample\n---\nBody' }],
      'skills.sh:x/y/z',
      'revision',
    );
    const file = path.join(info.path, '.bruin-source.json');
    for (const value of [
      null,
      [],
      {},
      { source: 'skills.sh:x/y/z', revision: 'r', enabled: 'false' },
    ]) {
      fs.writeFileSync(file, JSON.stringify(value));
      assert.equal(
        listSkills().some((skill) => skill.name === 'sample'),
        false,
      );
      assert.throws(() => loadSkill('sample'), /不存在/);
    }
  } finally {
    if (previous === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'skill installation and discovery never block on FIFO manifests or metadata',
  { skip: process.platform === 'win32' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-skill-fifo-'));
    try {
      const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { execFileSync } from 'node:child_process';
      import { installLocal, installSnapshot, listSkills, readSkill } from ${JSON.stringify(new URL('../skills/registry.js', import.meta.url).href)};
      const root = ${JSON.stringify(dir)};
      process.env.BRUIN_HOME = path.join(root, 'home');
      const source = path.join(root, 'source'); fs.mkdirSync(source);
      const manifest = path.join(source, 'SKILL.md');
      execFileSync('mkfifo', [manifest]);
      assert.throws(() => installLocal(source), /普通文件/);
      fs.unlinkSync(manifest);
      const external = path.join(root, 'external');
      fs.writeFileSync(external, '---\\nname: sample\\ndescription: sample\\n---\\nBody');
      fs.symlinkSync(external, manifest);
      assert.throws(() => installLocal(source), /符号链接/);
      const info = installSnapshot([{ path: 'SKILL.md', contents: fs.readFileSync(external, 'utf8') }], 'skills.sh:x/y/z', 'r');
      for (const name of ['SKILL.md', '.bruin-source.json']) {
        const file = path.join(info.path, name); const original = fs.readFileSync(file);
        fs.unlinkSync(file); execFileSync('mkfifo', [file]);
        assert.equal(listSkills().some((skill) => skill.name === 'sample'), false);
        assert.throws(() => readSkill('sample'), /不存在/);
        fs.unlinkSync(file); fs.writeFileSync(file, original);
      }
    `;
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 3000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('market snapshot validates paths and supports multiline descriptions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-market-test-'));
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  try {
    assert.throws(
      () => installSnapshot([{ path: '../escape', contents: 'bad' }], 'skills.sh:x/y/z', 'hash'),
      /路径无效/,
    );
    const skill = installSnapshot(
      [
        {
          path: 'SKILL.md',
          contents:
            '---\nname: sample\ndescription: >\n  A sample workflow\n  with two lines\n---\nInstructions\n',
        },
      ],
      'skills.sh:x/y/z',
      'hash',
    );
    assert.equal(skill.name, 'sample');
    assert.match(skill.description, /sample workflow/);
    assert.throws(() => loadSkill('sample'), /未启用/);
    assert.match(readSkill('sample'), /Instructions/);
    setSkillEnabled('sample', true);
    assert.match(loadSkill('sample'), /Instructions/);
  } finally {
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
