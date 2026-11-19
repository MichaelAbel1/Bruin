import type { SessionEvent } from './types.js';

export function isPauseReport(event: SessionEvent, next?: SessionEvent): boolean {
  return (
    event.type === 'assistant' &&
    (event.payload.synthetic === 'pause_report' ||
      (typeof event.payload.text === 'string' &&
        next?.type === 'turn_paused' &&
        next.payload.report === event.payload.text))
  );
}

export function withoutPauseReports(events: SessionEvent[]): SessionEvent[] {
  return events.filter((event, index) => !isPauseReport(event, events[index + 1]));
}
