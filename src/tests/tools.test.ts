import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinition, toolDefinitions, toolsForMode } from '../core/tools.js';
import { toolSchemas } from '../providers/gateway.js';
import { decisionFor } from '../core/permissions.js';
import { planBlocks } from '../runtime/plan.js';
import { workspaceMounts } from '../executor/bwrap.js';
import type { ToolCall } from '../core/types.js';

test('registry preserves existing tool exposure and provider compatibility export', () => {
  assert.deepEqual(Object.keys(toolsForMode('read-only')).sort(), [
    'list_files',
    'list_snapshots',
    'load_skill',
    'read_file',
    'search',
    'search_repository',
  ]);
  assert.deepEqual(Object.keys(toolsForMode('basic')).sort(), [
    'edit_file',
    'list_files',
    'list_snapshots',
    'load_skill',
    'read_file',
    'restore_snapshot',
    'search',
    'search_repository',
    'shell',
    'write_file',
  ]);
  assert.deepEqual(
    Object.keys(toolsForMode('full')),
    Object.keys(toolDefinitions).filter((name) => name !== 'ask_user'),
  );
  assert.deepEqual(Object.keys(toolsForMode('full', true)), Object.keys(toolDefinitions));
  assert.equal(Object.hasOwn(toolsForMode('read-only', true), 'ask_user'), false);
  assert.equal(Object.hasOwn(toolsForMode('worktree', true), 'ask_user'), false);
  assert.deepEqual(Object.keys(toolSchemas), Object.keys(toolDefinitions));
  for (const definition of Object.values(toolDefinitions)) {
    if (definition.parallel) {
      assert.equal(definition.readOnly, true);
      assert.equal(definition.target, 'executor');
      assert.equal(definition.replay, 'safe');
    }
  }
});

test('unknown and prototype tool names fail closed at lookup, planning and permission boundaries', () => {
  const state = { enabled: true, approved: false, steps: [], progress: {} };
  for (const name of ['unknown', '__proto__', 'constructor', 'toString']) {
    const call = { name, id: 'test', input: {} } as ToolCall;
    assert.equal(toolDefinition(name), undefined);
    assert.equal(planBlocks(call, state), true);
    assert.equal(decisionFor(call, '/does-not-exist').decision, 'deny');
  }
  assert.equal(planBlocks({ name: 'read_file', id: 'read', input: {} }, state), false);
  assert.equal(planBlocks({ name: 'write_file', id: 'write', input: {} }, state), true);
});

test('bwrap mounts shared scratch under /tmp after private /tmp and omits redundant /tmp bind', () => {
  const subScratch = workspaceMounts('/work/repo', {
    privateTmp: true,
    sharedScratch: '/tmp/ci-scratch',
  });
  const tmpfsIndex = subScratch.indexOf('--tmpfs');
  const scratchIndex = subScratch.indexOf('/tmp/ci-scratch');
  assert.ok(tmpfsIndex >= 0 && scratchIndex > tmpfsIndex);

  const rootTmp = workspaceMounts('/work/repo', { privateTmp: true, sharedScratch: '/tmp' });
  assert.equal(rootTmp.filter((arg, i) => arg === '--bind' && rootTmp[i + 1] === '/tmp').length, 0);

  for (const unsafe of ['/', '/tmp/', '/Users/alice', '/work']) {
    const args = workspaceMounts('/work/repo', { privateTmp: true, sharedScratch: unsafe });
    const binds = args.flatMap((arg, i) => (arg === '--bind' ? [args[i + 1]] : []));
    assert.deepEqual(binds, ['/work/repo'], `must reject unsafe sharedScratch: ${unsafe}`);
  }
});
