import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './cases.mjs';

const evaluator = fileURLToPath(new URL('./', import.meta.url));

function git(workspace, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Bruin Evaluation',
      GIT_AUTHOR_EMAIL: 'eval@example.test',
      GIT_COMMITTER_NAME: 'Bruin Evaluation',
      GIT_COMMITTER_EMAIL: 'eval@example.test',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      GIT_OPTIONAL_LOCKS: '0',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    maxBuffer: 2_000_000,
  });
}

function prepare(workspace, task) {
  fs.mkdirSync(workspace);
  for (const [relative, content] of Object.entries(task.files)) {
    const file = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o644 });
  }
  git(workspace, ['init', '-q', '--template=', '--object-format=sha1', '-b', 'main']);
  git(workspace, ['add', '--', '.']);
  git(workspace, ['commit', '-qm', 'evaluation baseline', '--no-gpg-sign']);
  for (const [relative, content] of Object.entries(task.edits))
    fs.writeFileSync(path.join(workspace, relative), content, { mode: 0o644 });
  return { baseCommit: git(workspace, ['rev-parse', 'HEAD']).trim(), prompt: task.prompt };
}

function splitPaths(output) {
  return output.split('\0').filter(Boolean);
}

function check(workspace, name, task) {
  assert.equal(fs.realpathSync(git(workspace, ['rev-parse', '--show-toplevel']).trim()), workspace);
  const baseCommit = git(workspace, ['rev-list', '--max-parents=0', 'HEAD']).trim();
  assert.match(baseCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(
    splitPaths(git(workspace, ['ls-tree', '-rz', '--name-only', baseCommit])).sort(),
    Object.keys(task.files).sort(),
  );
  for (const [file, content] of Object.entries(task.files))
    assert.equal(git(workspace, ['cat-file', 'blob', `${baseCommit}:${file}`]), content);
  const changedFiles = [
    ...new Set([
      ...splitPaths(
        git(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', baseCommit]),
      ),
      ...splitPaths(git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'])),
    ]),
  ].sort();
  const untouched = Object.entries(task.protected).every(([relative, rule]) => {
    const file = path.join(workspace, relative);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file)
      return false;
    const content = fs.readFileSync(file, 'utf8');
    return rule.line === undefined
      ? content === rule.exact
      : content.split('\n').includes(rule.line);
  });
  const processResult = spawnSync(
    process.execPath,
    [
      '--permission',
      `--allow-fs-read=${evaluator}`,
      `--allow-fs-read=${workspace}`,
      fileURLToPath(new URL('./verify.mjs', import.meta.url)),
      name,
      workspace,
    ],
    {
      cwd: workspace,
      env: { SystemRoot: process.env.SystemRoot },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 100_000,
    },
  );
  const functional =
    processResult.status === 0 &&
    !processResult.error &&
    processResult.stdout.trim() === 'acceptance checks completed';
  const allowed = new Set([...Object.keys(task.files), ...Object.keys(task.edits)]);
  const unexpectedFiles = changedFiles.filter((file) => !allowed.has(file));
  const result = {
    baseCommit,
    passed: untouched && functional && !unexpectedFiles.length,
    functional,
    preservedUserEdits: untouched,
    changedFiles,
    unexpectedFiles,
    ...(functional
      ? {}
      : {
          diagnostic:
            (processResult.error?.message ?? processResult.stderr.trim()) ||
            '未收到独立验收完成记录',
        }),
  };
  if (!result.passed) process.exitCode = 1;
  return result;
}

try {
  const [command, name, target, ...rest] = process.argv.slice(2);
  const task = cases.get(name);
  if (rest.length || !target || !task || !['prepare', 'check'].includes(command))
    throw new Error(
      `用法：node test/evals/run.mjs prepare|check ${[...cases.keys()].join('|')} DIRECTORY`,
    );
  const workspace = command === 'prepare' ? path.resolve(target) : fs.realpathSync(target);
  const result = command === 'prepare' ? prepare(workspace, task) : check(workspace, name, task);
  console.log(
    JSON.stringify({ case: name, workspace: fs.realpathSync(workspace), ...result }, null, 2),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
