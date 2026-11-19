import type { EventStore } from '../storage/event-store.js';
import type { AttachmentRef } from './attachments.js';
import { isPauseReport } from './pause-report.js';

export type QueuedInput = {
  id: string;
  mode: 'steer' | 'follow-up';
  text: string;
  attachments: AttachmentRef[];
  quote?: { text: string; seq: number };
};

// Notifications only wake the local run; SQLite events remain the durable queue.
const steeringWaiters = new WeakMap<EventStore, Map<string, Set<() => void>>>();

export function onSteeringInput(
  store: EventStore,
  sessionId: string,
  wake: () => void,
): () => void {
  let sessions = steeringWaiters.get(store);
  if (!sessions) steeringWaiters.set(store, (sessions = new Map()));
  let listeners = sessions.get(sessionId);
  if (!listeners) sessions.set(sessionId, (listeners = new Set()));
  listeners.add(wake);
  return () => {
    if (!listeners.delete(wake)) return;
    if (!listeners.size) sessions.delete(sessionId);
    if (!sessions.size) steeringWaiters.delete(store);
  };
}

export function pendingInputs(
  events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
) {
  const pending = new Map<string, QueuedInput>();
  for (const event of events) {
    if (event.type === 'input_queued') {
      const input = event.payload as QueuedInput;
      if (typeof input.id === 'string' && ['steer', 'follow-up'].includes(input.mode))
        pending.set(input.id, input);
    }
    if (event.type === 'user' && typeof event.payload.queuedInputId === 'string')
      pending.delete(event.payload.queuedInputId);
  }
  return [...pending.values()];
}

export function enqueueInput(store: EventStore, sessionId: string, input: QueuedInput) {
  if (pendingInputs(store.events(sessionId)).length >= 50)
    throw new Error('待处理消息最多 50 条，请等待当前队列处理');
  store.append(sessionId, 'input_queued', { ...input });
  if (input.mode === 'steer')
    for (const wake of steeringWaiters.get(store)?.get(sessionId) ?? []) wake();
}

/** An admitted message must reach the model before another queued input replaces
 * its current attachments. Pause reports are UI output, not model responses. */
function hasUnansweredInput(events: ReturnType<EventStore['events']>): boolean {
  let unanswered = false;
  for (const [index, event] of events.entries()) {
    if (event.type === 'user') unanswered = true;
    if (event.type === 'turn_completed') unanswered = false;
    if (event.type === 'assistant' && !isPauseReport(event, events[index + 1])) unanswered = false;
  }
  return unanswered;
}

/** The user event is both model input and durable receipt: no separate ack crash gap. */
export function consumeInputs(store: EventStore, sessionId: string, settled: boolean): string[] {
  const events = store.events(sessionId);
  if (hasUnansweredInput(events)) return [];
  const input = pendingInputs(events).find((input) => input.mode === 'steer' || settled);
  if (!input) return [];
  store.append(sessionId, 'user', {
    text: input.text,
    attachments: input.attachments,
    quote: input.quote,
    queuedInputId: input.id,
  });
  return [input.id];
}
