import { pendingApproval } from './approval.js';
import { pendingInputs } from './input-queue.js';
import { pendingQuestion } from './question.js';
import { pendingSubagents } from './recovery.js';
import { canResumeTurn, turnState, type TurnState } from './turn-state.js';
import { unreviewedUnknownTools } from './unknown-review.js';
import { recordedUsage } from './usage.js';
import { planState, type PlanState } from '../runtime/plan.js';
import type { SessionEvent } from './types.js';

export type SessionPhase =
  | 'idle'
  | 'awaiting_review'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'awaiting_plan_approval'
  | 'paused'
  | 'unfinished'
  | 'completed';

export interface SessionState {
  phase: SessionPhase;
  turnState: TurnState;
  canResume: boolean;
  needsReview: boolean;
  unreviewedUnknownCount: number;
  lastUnknownSeq: number | null;
  pendingApproval: ReturnType<typeof pendingApproval> | null;
  pendingQuestion: ReturnType<typeof pendingQuestion> | null;
  plan: PlanState & { pendingSteps: number };
  pendingInputsCount: number;
  pendingSubagents: Array<{
    childId: string;
    mode: string;
    prompt: string;
    workspace: string;
  }>;
  usage: {
    responses: number;
    inputTokens: string;
    outputTokens: string;
    inputReports: number;
    outputReports: number;
  };
  lastEventSeq: number;
}

/** Pure, deterministic projection of durable session events into unified execution & business state. */
export function reduceSessionState(events: readonly SessionEvent[]): SessionState {
  const state = turnState(events);
  const unreviewed = unreviewedUnknownTools(events);
  const needsReview = unreviewed.length > 0;
  const approval = pendingApproval(events) ?? null;
  const question = pendingQuestion(events) ?? null;
  const plan = planState([...events]);
  const pendingSteps =
    plan.enabled && plan.approved
      ? plan.steps.filter((_step, index) => plan.progress[index] !== 'completed').length
      : 0;
  const awaitingPlanApproval = plan.enabled && !plan.approved && plan.steps.length > 0;
  const inputs = pendingInputs(events);
  const children = pendingSubagents(events).map((event) => ({
    childId: String(event.payload.childId ?? ''),
    mode: String(event.payload.mode ?? 'read-only'),
    prompt: String(event.payload.prompt ?? '').slice(0, 200),
    workspace: String(event.payload.workspace ?? ''),
  }));

  let phase: SessionPhase;
  if (needsReview) phase = 'awaiting_review';
  else if (approval) phase = 'awaiting_approval';
  else if (question) phase = 'awaiting_input';
  else if (awaitingPlanApproval && (state === 'completed' || state === 'idle'))
    phase = 'awaiting_plan_approval';
  else phase = state;

  const usage = recordedUsage(events);
  return {
    phase,
    turnState: state,
    canResume: !needsReview && canResumeTurn(events),
    needsReview,
    unreviewedUnknownCount: unreviewed.length,
    lastUnknownSeq: unreviewed.at(-1)?.seq ?? null,
    pendingApproval: approval,
    pendingQuestion: question,
    plan: { ...plan, pendingSteps },
    pendingInputsCount: inputs.length,
    pendingSubagents: children,
    usage: {
      responses: usage.responses,
      inputTokens: usage.inputTokens.toString(),
      outputTokens: usage.outputTokens.toString(),
      inputReports: usage.inputReports,
      outputReports: usage.outputReports,
    },
    lastEventSeq: events.at(-1)?.seq ?? 0,
  };
}
