import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installSnapshot,
  listSkills,
  loadSkill,
  readSkill,
  setSkillEnabled,
  uninstallSkill,
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
