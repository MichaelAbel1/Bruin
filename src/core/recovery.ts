import type { EventStore } from '../storage/event-store.js';
import type { SessionEvent, ToolCall } from './types.js';
import { toolDefinition } from './tools.js';
import { originalSubagentTurn } from './subagent-results.js';
import { pendingApproval, resumableApprovalBatch } from './approval.js';

/** Project only recorded receipts; an absent receipt is not proof of success or failure. */
export function pendingSubagents(events: readonly SessionEvent[]): SessionEvent[] {
  const pending = new Map<string, SessionEvent>();
  for (const event of events) {
    if (typeof event.payload.childId !== 'string') continue;
    if (event.type === 'subagent_started') pending.set(event.payload.childId, event);
    if (event.type === 'subagent_finished') pending.delete(event.payload.childId);
  }
  return [...pending.values()];
}

function recordedChildResult(started: SessionEvent, events: readonly SessionEvent[]) {
  const { user, terminal, answer } = originalSubagentTurn(events);
  if (!terminal || !user || user.payload.text !== started.payload.prompt) return;
  return {
    status: terminal.type === 'turn_completed' ? 'completed' : 'failed',
    answer,
    ...(terminal.type === 'turn_paused'
      ? { error: '子 Agent 已达到运行预算并暂停，任务尚未完成；请检查子会话后继续' }
      : {}),
    throughSeq: terminal.seq,
  };
}

function recoverChildResults(
  store: EventStore,
  sessionId: string,
  events: readonly SessionEvent[],
): void {
  for (const started of pendingSubagents(events)) {
    const childId = String(started.payload.childId);
    if (!store.getSession(childId) || store.isLeased(childId)) continue;
    const result = recordedChildResult(started, store.events(childId));
    if (!result) continue;
    store.append(sessionId, 'subagent_finished', {
      childId,
      ...result,
      workspace: started.payload.workspace,
      mode: started.payload.mode,
      baseCommit: started.payload.baseCommit,
      recovered: true,
    });
  }
}

/** Reconcile interruption evidence without replaying external actions.
 * Callers hold the parent session lease while appending recovery receipts. */
export function recoverSession(store: EventStore, sessionId: string): number {
  const events = store.events(sessionId);
  type CallIdentity = Pick<ToolCall, 'id' | 'name'>;
  const pending = new Map<
    string,
    Array<{ call: CallIdentity; recovery: 'not-started' | 'safe' | 'manual'; startedSeq?: number }>
  >();
  const delegations = new Map<number, string>();
  const trackCall = (call: CallIdentity) => {
    const queue = pending.get(call.id) ?? [];
    queue.push({ call, recovery: 'not-started' });
    pending.set(call.id, queue);
  };
  for (const event of events) {
    if (event.type === 'assistant')
      for (const call of (event.payload.calls ?? []) as ToolCall[]) trackCall(call);
    if (
      event.type === 'tool_requested' &&
      event.payload.source === 'desktop' &&
      event.payload.name === 'spawn_subagent' &&
      typeof event.payload.callId === 'string'
    )
      trackCall({ id: event.payload.callId, name: 'spawn_subagent' });
    if (event.type === 'tool_started') {
      const item = pending
        .get(String(event.payload.callId))
        ?.find((item) => item.recovery === 'not-started');
      if (item) {
        item.recovery =
          event.payload.recovery === 'safe' &&
          toolDefinition(item.call.name)?.target === 'executor' &&
          toolDefinition(item.call.name)?.replay === 'safe'
            ? 'safe'
            : 'manual';
        if (item.call.name === 'spawn_subagent' && event.payload.name === item.call.name)
          item.startedSeq = event.seq;
      }
    }
    if (event.type === 'subagent_started') {
      const { toolStartedSeq, childId } = event.payload;
      if (
        typeof toolStartedSeq === 'number' &&
        toolStartedSeq < event.seq &&
        typeof childId === 'string'
      )
        delegations.set(toolStartedSeq, childId);
    }
    if (['tool_finished', 'tool_unknown', 'tool_denied'].includes(event.type)) {
      const queue = pending.get(String(event.payload.callId));
      queue?.shift();
      if (queue?.length === 0) pending.delete(String(event.payload.callId));
    }
  }
  // Preserve unstarted calls belonging to an explicit approval-paused assistant batch.
  const preservedCallIds = new Set<string>();
  const activeApproval = pendingApproval(events);
  if (activeApproval) {
    let lastAssistantCalls: ToolCall[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].seq < activeApproval.seq && events[i].type === 'assistant') {
        lastAssistantCalls = Array.isArray(events[i].payload.calls)
          ? (events[i].payload.calls as ToolCall[])
          : [];
        break;
      }
    }
    const idx = lastAssistantCalls.findIndex((c) => c.id === activeApproval.callId);
    if (idx >= 0) {
      for (const call of lastAssistantCalls.slice(idx)) preservedCallIds.add(call.id);
    } else {
      preservedCallIds.add(activeApproval.callId);
    }
  } else {
    const resumable = resumableApprovalBatch(events);
    if (resumable) {
      for (const call of resumable.calls) preservedCallIds.add(call.id);
    }
  }
  let unknown = 0;
  for (const queue of pending.values())
    for (const { call, recovery, startedSeq } of queue) {
      if (recovery === 'not-started' && preservedCallIds.has(call.id)) continue;
      const childId = startedSeq === undefined ? undefined : delegations.get(startedSeq);
      if (childId) {
        store.append(sessionId, 'tool_finished', {
          callId: call.id,
          name: call.name,
          isError: false,
          output: `已恢复子 Agent 启动记录: ${childId}。请用 subagent_status 查看任务状态。`,
        });
        continue;
      }
      const type =
        recovery === 'not-started'
          ? 'tool_denied'
          : recovery === 'safe'
            ? 'tool_finished'
            : 'tool_unknown';
      store.append(sessionId, type, {
        callId: call.id,
        name: call.name,
        ...(type === 'tool_finished' ? { isError: true } : {}),
        output:
          recovery === 'not-started'
            ? 'Action was not started before interruption. It has not been replayed.'
            : recovery === 'safe'
              ? 'Read interrupted; no result is available. Inspect again if needed; this call has not been replayed.'
              : 'Execution status unknown after interruption. Do not assume this action did or did not happen.',
      });
      if (type === 'tool_unknown') unknown++;
    }
  recoverChildResults(store, sessionId, events);
  return unknown;
}
