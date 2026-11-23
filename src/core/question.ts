import type { EventStore } from '../storage/event-store.js';

type Event = { seq: number; type: string; payload: Record<string, unknown> };

export function pendingQuestion(events: readonly Event[]) {
  for (let index = events.length - 1; index >= 0; index--) {
    const { type, seq, payload } = events[index];
    if (type === 'user' || type === 'turn_completed') break;
    if (
      type === 'tool_finished' &&
      payload.name === 'ask_user' &&
      !payload.isError &&
      typeof payload.questionId === 'string' &&
      typeof payload.question === 'string'
    )
      return { id: payload.questionId, text: payload.question, seq };
  }
}

/** The answer is the user event. Callers hold the session lease through this write. */
export function recordQuestionAnswer(
  store: EventStore,
  sessionId: string,
  id: string,
  answer: string,
) {
  const question = pendingQuestion(store.events(sessionId));
  const text = answer.trim();
  if (!question || question.id !== id) throw new Error('问题已答复或不属于当前会话');
  if (!text || text.length > 10_000) throw new Error('请输入 1 至 10,000 字符的答复');
  return store.append(sessionId, 'user', {
    text,
    answerTo: id,
    quote: { text: question.text, seq: question.seq },
  });
}
