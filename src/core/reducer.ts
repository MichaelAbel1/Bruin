import {
  pendingApproval,
  resumableApprovalBatch,
  type PendingApproval,
  type ResumableApprovalBatch,
} from './approval.js';
import { pendingQuestion, type PendingQuestion } from './question.js';
import { unreviewedUnknownTools } from './unknown-review.js';
import { planState } from '../runtime/plan.js';
import type { SessionEvent } from './types.js';
import type { ToolMode } from './tools.js';
import { rolePreset, type AgentRole } from './roles.js';

export type AgentAction =
  | { kind: 'blocked_review'; unreviewedCount: number; lastUnknownSeq: number }
  | { kind: 'await_approval'; approval: PendingApproval }
  | { kind: 'await_question'; question: PendingQuestion }
  | { kind: 'resume_tool_batch'; batch: ResumableApprovalBatch }
  | { kind: 'call_model'; effectiveToolMode: ToolMode }
  | { kind: 'pause_step_limit'; maxSteps: number };

export interface NextActionOptions {
  step: number;
  maxSteps: number;
  baseToolMode: ToolMode;
  role?: AgentRole;
}

/** Pure, stateless decision reducer: derives the exact next control step solely from durable events. */
export function nextAgentAction(
  events: readonly SessionEvent[],
  options: NextActionOptions,
): AgentAction {
  const unreviewed = unreviewedUnknownTools(events);
  if (unreviewed.length > 0) {
    return {
      kind: 'blocked_review',
      unreviewedCount: unreviewed.length,
      lastUnknownSeq: unreviewed.at(-1)!.seq,
    };
  }
  const approval = pendingApproval(events);
  if (approval) return { kind: 'await_approval', approval };

  const question = pendingQuestion(events);
  if (question) return { kind: 'await_question', question };

  const batch = resumableApprovalBatch(events);
  if (batch) return { kind: 'resume_tool_batch', batch };

  if (options.step >= options.maxSteps) {
    return { kind: 'pause_step_limit', maxSteps: options.maxSteps };
  }

  const plan = planState(events as SessionEvent[]);
  let effectiveToolMode: ToolMode = options.role
    ? rolePreset(options.role).toolMode
    : options.baseToolMode;
  if (
    plan.enabled &&
    !plan.approved &&
    (effectiveToolMode === 'full' || effectiveToolMode === 'basic')
  ) {
    effectiveToolMode = 'planning';
  }
  return { kind: 'call_model', effectiveToolMode };
}
