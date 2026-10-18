import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryContext } from '../core/memory.js';

const page = (key: string, content: string) => ({
  key,
  content,
  updatedAt: '2026-10-19T00:00:00.000Z',
});

test('relevant memory after a large unrelated page reaches the prompt with its source', () => {
  const result = memoryContext(
    [
      page('a-unrelated', 'unrelated '.repeat(1000)),
      page('z-oauth', 'OAuth refresh requires a new access token.'),
    ],
    'Fix OAuth refresh',
  );
  assert.ok(result.indexOf('z-oauth') < result.indexOf('a-unrelated'));
  assert.match(result, /OAuth refresh requires/);
  assert.match(result, /updatedAt/);
  assert.ok(result.length <= 8000);
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
  assert.ok(memoryContext(pages, '').indexOf('first') < memoryContext(pages, '').indexOf('second'));
  assert.deepEqual(pages, original);
  assert.equal(memoryContext(pages, '', 0), '');
  assert.equal(memoryContext([], 'anything'), '');
});
