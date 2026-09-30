import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listWorkspaceChanges, readWorkspaceReview } from '../core/workspace-review.js';
import { recordSnapshot } from '../core/snapshots.js';
import type { SessionEvent } from '../core/types.js';

function setup(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-review-'));
  const previous = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  t.after(() => {
    if (previous === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  return fs.realpathSync(workspace);
}
const event = (
  type: SessionEvent['type'],
  payload: Record<string, unknown>,
  at = new Date().toISOString(),
) => ({
  type,
  payload,
  at,
});

test('review pairs reused call IDs and excludes denied, failed and outside writes', (t) => {
  const workspace = setup(t);
  fs.writeFileSync(path.join(workspace, 'ok.txt'), 'done');
  const events = [
    event('tool_requested', { callId: 'same', name: 'write_file', input: { path: 'denied.txt' } }),
    event('tool_denied', { callId: 'same' }),
    event('tool_requested', { callId: 'same', name: 'edit_file', input: { path: 'ok.txt' } }),
    event('tool_finished', { callId: 'same', isError: false }),
    event('tool_requested', {
      callId: 'failed',
      name: 'write_file',
      input: { path: 'failed.txt' },
    }),
    event('tool_finished', { callId: 'failed', isError: true }),
    event('tool_requested', {
      callId: 'outside',
      name: 'write_file',
      input: { path: '../outside.txt' },
    }),
    event('tool_finished', { callId: 'outside', isError: false }),
  ];
  assert.deepEqual(listWorkspaceChanges(workspace, events), [
    { path: 'ok.txt', source: 'agent', status: 'modified' },
  ]);
  assert.deepEqual(
    listWorkspaceChanges(workspace, [...events, event('workspace_changed', {})]),
    [],
  );
  assert.throws(() => readWorkspaceReview(workspace, '../outside.txt', events), /变更列表/);
});

test('ordinary workspace review uses the first successful write snapshot', (t) => {
  const workspace = setup(t);
  const file = path.join(workspace, 'file.txt');
  fs.writeFileSync(file, 'original');
  const from = new Date(Date.now() - 1000).toISOString();
  recordSnapshot(workspace, file, Buffer.from('changed'));
  fs.writeFileSync(file, 'changed');
  const to = new Date(Date.now() + 1000).toISOString();
  const events = [
    event('tool_requested', { callId: 'w', name: 'write_file', input: { path: 'file.txt' } }, from),
    event('tool_finished', { callId: 'w', isError: false }, to),
  ];
  const preview = readWorkspaceReview(workspace, 'file.txt', events);
  assert.equal(preview.content, 'changed');
  assert.equal(preview.baselineContent, 'original');
  fs.writeFileSync(file, 'original');
  assert.equal(readWorkspaceReview(workspace, 'file.txt', events).baselineContent, 'original');
});

test('review covers Git changes in repository subdirectories, spaces, additions and deletions', (t) => {
  const root = setup(t);
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '-q']);
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'changed file.txt'), 'before');
  fs.writeFileSync(path.join(root, 'nested', 'deleted.txt'), 'deleted content');
  fs.writeFileSync(path.join(root, 'other.txt'), 'outside workspace');
  git(['add', '.']);
  git([
    '-c',
    'user.name=Review',
    '-c',
    'user.email=review@example.test',
    'commit',
    '-qm',
    'initial',
  ]);
  fs.writeFileSync(path.join(root, 'nested', 'changed file.txt'), 'after');
  fs.unlinkSync(path.join(root, 'nested', 'deleted.txt'));
  fs.writeFileSync(path.join(root, 'nested', 'new.txt'), 'new');
  fs.writeFileSync(path.join(root, 'other.txt'), 'changed outside');
  const workspace = path.join(root, 'nested');
  assert.deepEqual(listWorkspaceChanges(workspace, []), [
    { path: 'changed file.txt', source: 'workspace', status: 'modified' },
    { path: 'deleted.txt', source: 'workspace', status: 'deleted' },
    { path: 'new.txt', source: 'workspace', status: 'added' },
  ]);
  assert.equal(readWorkspaceReview(workspace, 'changed file.txt', []).baselineContent, 'before');
  assert.equal(readWorkspaceReview(workspace, 'new.txt', []).baselineContent, '');
  const deleted = readWorkspaceReview(workspace, 'deleted.txt', []);
  assert.equal(deleted.content, '');
  assert.equal(deleted.baselineContent, 'deleted content');
  assert.match(deleted.readOnlyReason ?? '', /只读/);
  git(['restore', 'nested/changed file.txt']);
  git(['mv', 'nested/changed file.txt', 'nested/renamed.txt']);
  const renamed = listWorkspaceChanges(workspace, []);
  assert.ok(renamed.some((item) => item.path === 'changed file.txt' && item.status === 'deleted'));
  assert.ok(renamed.some((item) => item.path === 'renamed.txt' && item.status === 'added'));
  assert.equal(readWorkspaceReview(workspace, 'changed file.txt', []).baselineContent, 'before');
});

test('review rejects symbolic links and handles unmaterialized workspaces', (t) => {
  const root = setup(t);
  assert.deepEqual(listWorkspaceChanges(path.join(root, 'missing'), []), []);
  if (process.platform === 'win32') return;
  const file = path.join(root, 'link.txt');
  fs.symlinkSync(path.join(root, '../secret.txt'), file);
  fs.writeFileSync(path.join(root, '../secret.txt'), 'secret');
  const events = [
    event('tool_requested', { callId: 'w', name: 'write_file', input: { path: 'link.txt' } }),
    event('tool_finished', { callId: 'w' }),
  ];
  assert.throws(() => readWorkspaceReview(root, 'link.txt', events), /符号链接/);
});
