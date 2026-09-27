import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSnapshot, loadSkill, readSkill, setSkillEnabled } from '../skills/registry.js';

test('market snapshot validates paths and supports multiline descriptions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-market-test-'));
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
    delete process.env.BRUIN_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
