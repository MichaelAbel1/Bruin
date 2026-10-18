import type { EventStore } from '../storage/event-store.js';
import type { AttachmentRef } from './attachments.js';

export type QueuedInput = {
  id: string;
  mode: 'steer' | 'follow-up';
  text: string;
  attachments: AttachmentRef[];
  quote?: { text: string; seq: number };
};

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
}

/** The user event is both model input and durable receipt: no separate ack crash gap. */
export function consumeInputs(store: EventStore, sessionId: string, settled: boolean): string[] {
  const inputs = pendingInputs(store.events(sessionId)).filter(
    (input) => input.mode === 'steer' || settled,
  );
  for (const input of inputs)
    store.append(sessionId, 'user', {
      text: input.text,
      attachments: input.attachments,
      quote: input.quote,
      queuedInputId: input.id,
    });
  return inputs.map((input) => input.id);
}
