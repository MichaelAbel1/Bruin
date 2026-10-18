import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinition, toolDefinitions, toolsForMode } from '../core/tools.js';
import { toolSchemas } from '../providers/gateway.js';
import { decisionFor } from '../core/permissions.js';
import { planBlocks } from '../runtime/plan.js';
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
  assert.deepEqual(Object.keys(toolsForMode('full')), Object.keys(toolDefinitions));
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
