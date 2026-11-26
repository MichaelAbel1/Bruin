import type { EventStore } from '../storage/event-store.js';
import type { ToolCall, ToolName } from './types.js';

type Event = { seq: number; type: string; payload: Record<string, unknown> };

export interface PendingApproval {
  id: string;
  callId: string;
  name: ToolName;
  input: Record<string, unknown>;
  reason: string;
  workspace: string;
  seq: number;
}

export interface ResumableApprovalBatch {
  assistantSeq: number;
  calls: ToolCall[];
  preApprovedCallIds: string[];
  requestedCallIds: string[];
}

/** Pure projection of an unresolved persisted tool approval awaiting human decision. */
export function pendingApproval(events: readonly Event[]): PendingApproval | undefined {
  let current: PendingApproval | undefined;
  for (const event of events) {
    if (event.type === 'turn_completed' || event.type === 'workspace_changed') {
      current = undefined;
      continue;
    }
    if (event.type === 'approval_pending') {
      const { approvalId, callId, name, input, reason, workspace } = event.payload;
      if (
        typeof approvalId === 'string' &&
        approvalId &&
        typeof callId === 'string' &&
        callId &&
        typeof name === 'string' &&
        name &&
        typeof workspace === 'string' &&
        workspace
      ) {
        current = {
          id: approvalId,
          callId,
          name: name as ToolName,
          input:
            input && typeof input === 'object' && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
          reason: typeof reason === 'string' ? reason : '',
          workspace,
          seq: event.seq,
        };
      }
      continue;
    }
    if (
      current &&
      ['tool_approved', 'tool_denied', 'tool_finished', 'tool_unknown'].includes(event.type) &&
      event.payload.callId === current.callId
    ) {
      current = undefined;
    }
  }
  return current;
}

/** Find remaining calls from an assistant batch that paused cleanly at approval_pending and has now been decided. */
export function resumableApprovalBatch(
  events: readonly Event[],
): ResumableApprovalBatch | undefined {
  if (pendingApproval(events)) return undefined;
  let boundaryIndex = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i].type;
    if (type === 'turn_completed' || type === 'workspace_changed' || type === 'user') {
      boundaryIndex = i + 1;
      break;
    }
  }
  let assistantIndex = -1;
  for (let i = events.length - 1; i >= boundaryIndex; i--) {
    if (events[i].type === 'assistant') {
      assistantIndex = i;
      break;
    }
  }
  if (assistantIndex < 0) return undefined;
  const assistant = events[assistantIndex];
  const calls = Array.isArray(assistant.payload.calls)
    ? (assistant.payload.calls as ToolCall[])
    : [];
  if (!calls.length) return undefined;

  let hadApprovalPause = false;
  const requested = new Set<string>();
  const approved = new Set<string>();
  const started = new Set<string>();
  const settled = new Set<string>();
  for (let i = assistantIndex + 1; i < events.length; i++) {
    const ev = events[i];
    const callId = typeof ev.payload.callId === 'string' ? ev.payload.callId : '';
    if (ev.type === 'approval_pending') hadApprovalPause = true;
    if (!callId) continue;
    if (ev.type === 'tool_requested') requested.add(callId);
    else if (ev.type === 'tool_approved') approved.add(callId);
    else if (ev.type === 'tool_started') started.add(callId);
    else if (['tool_finished', 'tool_denied', 'tool_unknown'].includes(ev.type))
      settled.add(callId);
  }
  if (!hadApprovalPause) return undefined;
  const remaining = calls.filter((call) => !settled.has(call.id) && !started.has(call.id));
  if (!remaining.length) return undefined;
  return {
    assistantSeq: assistant.seq,
    calls: remaining,
    preApprovedCallIds: remaining.filter((call) => approved.has(call.id)).map((call) => call.id),
    requestedCallIds: remaining.filter((call) => requested.has(call.id)).map((call) => call.id),
  };
}

/** Persist a human approval or denial for a pending persisted approval request.
 * Callers must hold the session lease through this write. */
export function recordApprovalDecision(
  store: EventStore,
  sessionId: string,
  approvalId: string,
  approved: boolean,
  options: { reason?: string; source?: 'cli' | 'desktop' | 'acp' } = {},
): PendingApproval {
  const session = store.getSession(sessionId);
  if (!session) throw new Error('会话不存在');
  const pending = pendingApproval(store.events(sessionId));
  if (!pending || pending.id !== approvalId) throw new Error('审批请求已失效或不属于当前会话');
  if (session.workspace !== pending.workspace) throw new Error('工作区已变更，原审批请求已失效');
  if (approved) {
    store.append(sessionId, 'tool_approved', {
      callId: pending.callId,
      name: pending.name,
      reason: pending.reason,
      approvalId: pending.id,
      ...(options.source ? { source: options.source } : {}),
    });
  } else {
    store.append(sessionId, 'tool_denied', {
      callId: pending.callId,
      name: pending.name,
      output: options.reason?.trim() || '用户拒绝',
      approvalId: pending.id,
      ...(options.source ? { source: options.source } : {}),
    });
  }
  return pending;
}
