import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryContext, workspaceMemoryQuery } from '../core/memory.js';
import type { SessionEvent } from '../core/types.js';

const page = (key: string, content: string) => ({
  key,
  content,
  updatedAt: '2026-10-19T00:00:00.000Z',
});

test('relevant memory after a large unrelated page reaches the prompt with its source', () => {
  const result = memoryContext(
    [
      page('a-unrelated', 'unrelated '.repeat(1000)),
      page('z-oauth', 'OAuth refresh requires a new access token. ' + 'detail '.repeat(1000)),
    ],
    'Fix OAuth refresh',
  );
  assert.ok(result.indexOf('z-oauth') < result.indexOf('a-unrelated'));
  assert.match(result, /OAuth refresh requires/);
  assert.match(result, /updatedAt/);
  assert.doesNotMatch(result, /unrelated /);
  assert.ok(result.length < 2300);
  assert.match(result, /truncated; use list_memory/);
});

test('Chinese query uses overlapping phrases and normalized Latin terms', () => {
  const result = memoryContext(
    [page('a', '界面布局'), page('b', '数据库迁移必须备份'), page('c', 'OAuth login')],
    '修复数据库迁移 ＯＡＵＴＨ',
  );
  assert.ok(result.indexOf('"b"') < result.indexOf('"a"'));
  assert.ok(result.indexOf('"c"') < result.indexOf('"a"'));
});

test('empty or unmatched queries preserve source order without modifying pages', () => {
  const pages = [page('a', 'first'), page('b', 'second')];
  const original = structuredClone(pages);
  assert.equal(memoryContext(pages, ''), memoryContext(pages, 'unknown'));
  assert.ok(memoryContext(pages, '').indexOf('"a"') < memoryContext(pages, '').indexOf('"b"'));
  assert.doesNotMatch(memoryContext(pages, 'unknown'), /first|second/);
  assert.deepEqual(pages, original);
  assert.equal(memoryContext(pages, '', 0), '');
  assert.equal(memoryContext([], 'anything'), '');
});

test('memory query uses successful local file paths and excludes previous work and rejected paths', () => {
  const workspace = process.cwd();
  const events: SessionEvent[] = [];
  const add = (type: SessionEvent['type'], payload: SessionEvent['payload']) =>
    events.push({
      sessionId: 'memory-test',
      seq: events.length + 1,
      at: '',
      type,
      payload,
    });
  add('user', { text: 'Check the older billing flow.' });
  add('user', { text: 'Inspect the configuration' });
  add('tool_requested', {
    callId: 'read',
    name: 'read_file',
    input: { path: 'src/payments/reserve.ts' },
  });
  add('tool_finished', { callId: 'read', isError: false });
  add('tool_requested', {
    callId: 'read',
    name: 'read_file',
    input: { path: '../layout/private.ts' },
  });
  add('tool_denied', { callId: 'read' });
  add('user', { text: 'Continue the task.' });
  const query = workspaceMemoryQuery(workspace, events);
  assert.match(query, /configuration/);
  assert.match(query, /payments reserve/);
  assert.doesNotMatch(query, /older billing|layout private/);
  const memory = memoryContext(
    [
      page('billing', 'Old billing records'),
      page('payments', 'PAYMENTS_RULE'),
      page('other', 'Check and fix an unrelated tool'),
    ],
    query,
  );
  assert.match(memory, /PAYMENTS_RULE/);
  assert.doesNotMatch(memory, /Old billing records|unrelated tool/);
  add('workspace_changed', {});
  add('user', { text: 'Continue' });
  assert.equal(workspaceMemoryQuery(workspace, events), '');
});

test('memoryContext ignores single-character Latin tokens and avoids splitting UTF-16 surrogate pairs', () => {
  const result = memoryContext(
    [
      page('deploy', 'Deploy via blue-green rollout.'),
      page('ui-theme', 'Dark palette configuration with indigo accent.'),
    ],
    'I want to deploy',
  );
  assert.match(result, /Deploy via blue-green rollout/);
  assert.doesNotMatch(result, /Dark palette configuration/);

  const emojiContent = 'deploy ' + 'x'.repeat(1940) + '🚀'.repeat(40);
  const truncated = memoryContext([page('deploy', emojiContent)], 'deploy');
  // Verify no lone high surrogate exists anywhere in the output.
  for (let i = 0; i < truncated.length; i++) {
    const code = truncated.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = truncated.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'lone high surrogate detected');
    }
  }
});
