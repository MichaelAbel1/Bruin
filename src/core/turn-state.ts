import { pendingInputs } from './input-queue.js';

export type TurnState = 'idle' | 'unfinished' | 'paused' | 'completed';

/** Background receipts and configuration edits do not change the conversation's
 * control state. Only turn boundaries and evidence of unfinished model work do. */
export function turnState(events: ReadonlyArray<{ type: string }>): TurnState {
  for (let index = events.length - 1; index >= 0; index--) {
    switch (events[index].type) {
      case 'turn_completed':
        return 'completed';
      case 'turn_paused':
        return 'paused';
      case 'user':
      case 'assistant':
      case 'model_error':
      case 'tool_unknown':
        return 'unfinished';
    }
  }
  return 'idle';
}

export function canResumeTurn(
  events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
) {
  const state = turnState(events);
  return state === 'unfinished' || state === 'paused' || pendingInputs(events).length > 0;
}
