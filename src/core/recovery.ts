import type { EventStore } from '../storage/event-store.js';
import type { SessionEvent, ToolCall } from './types.js';
import { toolDefinition } from './tools.js';

/** Reconcile interruption evidence without replaying external actions. */
export function recoverSession(store: EventStore, sessionId: string): number {
  const events = store.events(sessionId);
  const pending = new Map<
    string,
    Array<{ call: ToolCall; recovery: 'not-started' | 'safe' | 'manual' }>
  >();
  for (const event of events) {
    if (event.type === 'assistant')
      for (const call of (event.payload.calls ?? []) as ToolCall[]) {
        const queue = pending.get(call.id) ?? [];
        queue.push({ call, recovery: 'not-started' });
        pending.set(call.id, queue);
      }
    if (event.type === 'tool_started') {
      const item = pending
        .get(String(event.payload.callId))
        ?.find((item) => item.recovery === 'not-started');
      if (item)
        item.recovery =
          event.payload.recovery === 'safe' &&
          toolDefinition(item.call.name)?.target === 'executor' &&
          toolDefinition(item.call.name)?.replay === 'safe'
            ? 'safe'
            : 'manual';
    }
    if (['tool_finished', 'tool_unknown', 'tool_denied'].includes(event.type)) {
      const queue = pending.get(String(event.payload.callId));
      queue?.shift();
      if (queue?.length === 0) pending.delete(String(event.payload.callId));
    }
  }
  let unknown = 0;
  for (const queue of pending.values())
    for (const { call, recovery } of queue) {
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
  return unknown;
}

export function needsUnknownReview(events: SessionEvent[], reviewedThrough = -1): boolean {
  const completed =
    [...events].reverse().find((event) => event.type === 'turn_completed')?.seq ?? 0;
  const unknown =
    events.filter((event) => event.type === 'tool_unknown' && event.seq > completed).at(-1)?.seq ??
    0;
  const confirmed = events
    .filter(
      (event) => event.type === 'cron_reviewed' && Number.isSafeInteger(event.payload.throughSeq),
    )
    .reduce(
      (seq, event) => Math.max(seq, Math.min(event.seq - 1, Number(event.payload.throughSeq))),
      reviewedThrough,
    );
  return unknown > Math.max(0, confirmed);
}
