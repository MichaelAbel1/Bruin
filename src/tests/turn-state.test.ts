import test from 'node:test';
import assert from 'node:assert/strict';
import { turnState } from '../core/turn-state.js';
import { reduceSessionState } from '../core/session-state.js';
import type { SessionEvent } from '../core/types.js';

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

test('reduceSessionState projects unified execution and business phases as JSON-safe state', () => {
  const make = (list: Array<[SessionEvent['type'], Record<string, unknown>?]>): SessionEvent[] =>
    list.map(([type, payload = {}], index) => ({
      sessionId: 'sess-1',
      seq: index + 1,
      type,
      at: '2026-11-25T00:00:00.000Z',
      payload,
    }));

  assert.equal(reduceSessionState([]).phase, 'idle');

  const awaitingInput = reduceSessionState(
    make([
      ['user', { text: 'migrate' }],
      [
        'tool_finished',
        {
          callId: 'q1',
          name: 'ask_user',
          questionId: 'q-1',
          question: 'Keep v1 API?',
          context: 'Two callers still use v1.',
          kind: 'decision',
          options: ['Keep v1', 'Drop v1'],
        },
      ],
      ['turn_paused', { reason: 'awaiting_input' }],
    ]),
  );
  assert.equal(awaitingInput.phase, 'awaiting_input');
  assert.equal(awaitingInput.pendingQuestion?.id, 'q-1');
  assert.deepEqual(awaitingInput.pendingQuestion?.options, ['Keep v1', 'Drop v1']);
  assert.equal(awaitingInput.pendingQuestion?.context, 'Two callers still use v1.');
  assert.equal(awaitingInput.pendingQuestion?.kind, 'decision');

  const awaitingReview = reduceSessionState(
    make([
      ['user', { text: 'deploy' }],
      ['tool_unknown', { callId: 'c1', name: 'shell' }],
      [
        'tool_finished',
        { callId: 'q1', name: 'ask_user', questionId: 'q-2', question: 'Confirm?' },
      ],
    ]),
  );
  assert.equal(awaitingReview.phase, 'awaiting_review');
  assert.equal(awaitingReview.needsReview, true);
  assert.equal(awaitingReview.canResume, false);
  assert.equal(awaitingReview.unreviewedUnknownCount, 1);
  assert.equal(awaitingReview.lastUnknownSeq, 2);

  const awaitingPlan = reduceSessionState(
    make([
      ['plan_mode', { enabled: true }],
      ['user', { text: 'plan it' }],
      ['plan_updated', { summary: 'Plan', steps: ['Step A', 'Step B'] }],
      [
        'assistant',
        { text: 'Proposed plan', calls: [], usage: { inputTokens: 120, outputTokens: 40 } },
      ],
      ['turn_completed', {}],
    ]),
  );
  assert.equal(awaitingPlan.phase, 'awaiting_plan_approval');
  assert.equal(awaitingPlan.usage.inputTokens, '120');
  assert.equal(awaitingPlan.usage.outputTokens, '40');
  assert.doesNotThrow(() => JSON.stringify(awaitingPlan));

  const approvedActive = reduceSessionState(
    make([
      ['plan_mode', { enabled: true }],
      ['plan_updated', { summary: 'Plan', steps: ['Step A', 'Step B'] }],
      ['plan_approved', {}],
      ['plan_progress', { index: 0, status: 'completed' }],
      ['user', { text: 'go' }],
      ['turn_paused', {}],
    ]),
  );
  assert.equal(approvedActive.phase, 'paused');
  assert.equal(approvedActive.canResume, true);
  assert.equal(approvedActive.plan.pendingSteps, 1);
});
