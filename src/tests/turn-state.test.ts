import test from 'node:test';
import assert from 'node:assert/strict';
import { turnState } from '../core/turn-state.js';

const events = (...types: string[]) => types.map((type) => ({ type }));
const metadata = [
  'background_finished',
  'subagent_finished',
  'hook_finished',
  'model_switched',
  'run_configured',
  'workspace_changed',
  'plan_progress',
  'cron_finished',
  'input_queued',
  'summary',
  'tool_requested',
  'tool_approved',
  'tool_started',
  'tool_finished',
  'tool_denied',
];

for (const terminal of ['turn_paused', 'turn_completed'] as const) {
  test(`${terminal} survives late receipts, configuration and standalone UI tools`, () => {
    for (const type of metadata)
      assert.equal(
        turnState(events('user', 'assistant', terminal, type)),
        terminal === 'turn_paused' ? 'paused' : 'completed',
        type,
      );
    assert.equal(
      turnState(events('user', 'assistant', terminal, ...metadata)),
      terminal === 'turn_paused' ? 'paused' : 'completed',
    );
  });
}

test('new input, model output, model failure and unknown effects invalidate the previous terminal state', () => {
  for (const terminal of ['turn_completed', 'turn_paused'])
    for (const next of ['user', 'assistant', 'model_error', 'tool_unknown'])
      assert.equal(
        turnState(events('user', terminal, next, ...metadata)),
        'unfinished',
        `${terminal} then ${next}`,
      );
});

test('the latest turn boundary wins; metadata alone does not create model work', () => {
  assert.equal(turnState([]), 'idle');
  assert.equal(turnState(events(...metadata)), 'idle');
  assert.equal(
    turnState(
      events('user', 'turn_paused', 'run_configured', 'assistant', 'turn_completed', ...metadata),
    ),
    'completed',
  );
  assert.equal(
    turnState(events('user', 'turn_completed', 'user', 'assistant', 'turn_paused', ...metadata)),
    'paused',
  );
  assert.equal(
    turnState(events('user', 'tool_unknown', 'turn_completed', ...metadata)),
    'completed',
  );
});
