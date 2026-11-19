import type { EventStore } from '../storage/event-store.js';
import type { SessionEvent } from './types.js';

type ReviewEvent = Pick<SessionEvent, 'seq' | 'payload'> & { type: string };

export function unreviewedUnknownTools<T extends ReviewEvent>(events: readonly T[]): T[] {
  let reviewedThrough = 0;
  for (const event of events) {
    if (event.type === 'turn_completed') reviewedThrough = Math.max(reviewedThrough, event.seq);
    if (event.type === 'unknown_reviewed' || event.type === 'cron_reviewed') {
      const through = event.payload.throughSeq;
      if (typeof through === 'number' && Number.isSafeInteger(through))
        reviewedThrough = Math.max(reviewedThrough, Math.min(event.seq - 1, through));
    }
  }
  return events.filter((event) => event.type === 'tool_unknown' && event.seq > reviewedThrough);
}

export function needsUnknownReview(events: readonly ReviewEvent[]): boolean {
  return unreviewedUnknownTools(events).length > 0;
}

/** The caller holds the session lease. A receipt can only cover observed unknown results. */
export function recordUnknownReview(
  store: EventStore,
  sessionId: string,
  throughSeq: unknown,
  source: 'desktop' | 'cli',
): void {
  const events = store.events(sessionId);
  if (
    typeof throughSeq !== 'number' ||
    !events.some((event) => event.type === 'tool_unknown' && event.seq === throughSeq)
  )
    throw new Error('请选择已显示的未知工具结果后确认');
  const lastReviewed = unreviewedUnknownTools(events)
    .filter((event) => event.seq <= throughSeq)
    .at(-1);
  if (lastReviewed)
    store.append(sessionId, 'unknown_reviewed', { throughSeq: lastReviewed.seq, source });
}
