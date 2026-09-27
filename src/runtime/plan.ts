import type { EventStore } from '../storage/event-store.js';
import type { SessionEvent, ToolCall } from '../core/types.js';

export type PlanState = {
  enabled: boolean;
  steps: string[];
  approved: boolean;
  progress: Record<number, 'pending' | 'in_progress' | 'completed'>;
};
export function planState(events: SessionEvent[]): PlanState {
  const state: PlanState = { enabled: false, steps: [], approved: false, progress: {} };
  for (const event of events) {
    if (event.type === 'plan_mode') {
      state.enabled = event.payload.enabled === true;
      state.approved = false;
    }
    if (event.type === 'plan_updated') {
      state.steps = (event.payload.steps as string[]) ?? [];
      state.progress = {};
      state.approved = false;
    }
    if (event.type === 'plan_approved') state.approved = true;
    if (event.type === 'plan_progress')
      state.progress[Number(event.payload.index)] = event.payload.status as
        'pending' | 'in_progress' | 'completed';
  }
  return state;
}
export function planBlocks(call: ToolCall, state: PlanState): boolean {
  return (
    state.enabled &&
    !state.approved &&
    ![
      'read_file',
      'search',
      'load_skill',
      'update_plan',
      'mcp_list_tools',
      'list_worktrees',
      'subagent_status',
      'background_status',
    ].includes(call.name)
  );
}
export function setPlanMode(store: EventStore, sessionId: string, enabled: boolean): PlanState {
  store.append(sessionId, 'plan_mode', { enabled });
  return planState(store.events(sessionId));
}
export function approvePlan(store: EventStore, sessionId: string): PlanState {
  const state = planState(store.events(sessionId));
  if (!state.enabled || !state.steps.length) throw new Error('当前没有可批准的规划');
  store.append(sessionId, 'plan_approved', {});
  return planState(store.events(sessionId));
}
export function setPlanProgress(
  store: EventStore,
  sessionId: string,
  index: number,
  status: 'pending' | 'in_progress' | 'completed',
): PlanState {
  const state = planState(store.events(sessionId));
  if (
    !state.enabled ||
    !state.approved ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= state.steps.length ||
    !['pending', 'in_progress', 'completed'].includes(status)
  )
    throw new Error('规划步骤不可更新');
  store.append(sessionId, 'plan_progress', { index, status });
  return planState(store.events(sessionId));
}
