import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadInstructions } from '../core/instructions.js';

test('non-regular instruction files are rejected before opening them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-instructions-'));
  const previous = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const target = path.join(dir, 'AGENTS.md');
  try {
    fs.mkdirSync(target);
    assert.throws(() => loadInstructions(dir), /不是普通文件/);
    fs.rmdirSync(target);
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [target]);
      // Use a separate process and a deadline so a blocking-open regression cannot hang tests.
      const module = new URL('../core/instructions.js', import.meta.url).href;
      const script = `import { loadInstructions } from ${JSON.stringify(module)}; try { loadInstructions(${JSON.stringify(dir)}); process.exit(1); } catch(error) { if (!String(error).includes('不是普通文件')) throw error; }`;
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
    }
  } finally {
    if (previous === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
