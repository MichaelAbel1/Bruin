import type { SessionEvent } from './types.js';
import { isPauseReport } from './pause-report.js';

/** A delegation owns the first child turn, including any partial result at its pause. */
export function originalSubagentTurn(events: readonly SessionEvent[]) {
  let user: SessionEvent | undefined;
  let terminal: SessionEvent | undefined;
  let answer = '';
  for (const [index, event] of events.entries()) {
    if (event.type === 'user') {
      if (user) break;
      user = event;
      answer = '';
    }
    if (event.type === 'assistant' && typeof event.payload.text === 'string') {
      if (event.payload.text.trim() && !isPauseReport(event, events[index + 1]))
        answer = excerpt(event.payload.text, 20_000);
    }
    if (event.type === 'turn_completed' || event.type === 'turn_paused') {
      terminal = event;
      break;
    }
  }
  return { user, terminal, answer };
}

function excerpt(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
}

/** Reduce preview text before dropping older records, so truncation cannot cut JSON or hide recent IDs. */
export function subagentPreviews(events: readonly SessionEvent[], limit: number): string {
  const recent = events.slice(-10).reverse();
  const render = (textLimit: number) =>
    JSON.stringify(
      recent.map(({ payload }) => {
        const answer = typeof payload.answer === 'string' ? payload.answer : '';
        const error = typeof payload.error === 'string' ? payload.error : undefined;
        const workspace = typeof payload.workspace === 'string' ? payload.workspace : undefined;
        return {
          childId: payload.childId,
          status: payload.status,
          mode: payload.mode,
          ...(answer && textLimit ? { answer: excerpt(answer, textLimit) } : {}),
          ...(error && textLimit ? { error: excerpt(error, textLimit) } : {}),
          ...(workspace && textLimit ? { workspace: excerpt(workspace, textLimit) } : {}),
          ...(answer.length > textLimit ||
          (error?.length ?? 0) > textLimit ||
          (workspace?.length ?? 0) > textLimit
            ? { truncated: true }
            : {}),
        };
      }),
    );
  let textLimit = 4000;
  let json = render(textLimit);
  while (json.length > limit && textLimit > 0) {
    textLimit = Math.floor(textLimit / 2);
    json = render(textLimit);
  }
  while (json.length > limit && recent.length) {
    recent.pop();
    json = render(0);
  }
  return json;
}
