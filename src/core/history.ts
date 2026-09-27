import type { ModelMessage } from 'ai';
import type { SessionEvent, ToolCall } from './types.js';

/** Build a provider-neutral prompt from durable events, never from a provider's remote session. */
export function buildPrompt(
  events: SessionEvent[],
  system: string,
  profileAlias?: string,
  protocol?: string,
): ModelMessage[] {
  // Keep whole turns within a conservative character budget. Durable events remain untouched.
  const userIndexes = events.flatMap((e, i) => (e.type === 'user' ? [i] : []));
  const maxHistoryChars = 100_000;
  let firstTurn = Math.max(0, userIndexes.length - 10);
  while (
    firstTurn < userIndexes.length - 1 &&
    JSON.stringify(events.slice(userIndexes[firstTurn])).length > maxHistoryChars
  )
    firstTurn++;
  if (firstTurn > 0) {
    const cut = userIndexes[firstTurn];
    const old = events
      .slice(0, cut)
      .filter((e) => e.type === 'user' || e.type === 'assistant')
      .map((e) => `${e.type}: ${String(e.payload.text ?? '').slice(0, 300)}`)
      .join('\n');
    events = [
      {
        sessionId: events[0].sessionId,
        seq: 0,
        type: 'summary',
        at: events[0].at,
        payload: { text: old.slice(-8000) },
      },
      ...events.slice(cut),
    ];
  }
  const messages: ModelMessage[] = [{ role: 'system', content: system }];
  const lastModelSwitchSeq = events.reduce(
    (seq, event) => (event.type === 'model_switched' ? Math.max(seq, event.seq) : seq),
    0,
  );
  for (const event of events) {
    if (event.type === 'user')
      messages.push({ role: 'user', content: String(event.payload.text ?? '') });
    if (event.type === 'summary')
      messages.push({
        role: 'user',
        content: `Earlier conversation summary:\n${String(event.payload.text ?? '')}`,
      });
    if (event.type === 'assistant') {
      const raw = event.payload.providerMessages;
      if (
        event.seq > lastModelSwitchSeq &&
        profileAlias &&
        event.payload.profileAlias === profileAlias &&
        protocol &&
        event.payload.protocol === protocol &&
        Array.isArray(raw) &&
        raw.length &&
        JSON.stringify(raw).length < 30_000
      ) {
        messages.push(...(raw as ModelMessage[]));
        continue;
      }
      const calls = (event.payload.calls ?? []) as ToolCall[];
      const text = String(event.payload.text ?? '').slice(0, 40_000);
      if (calls.length)
        messages.push({
          role: 'assistant',
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...calls.map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            })),
          ],
        });
      else if (text) messages.push({ role: 'assistant', content: text });
    }
    if (
      event.type === 'tool_finished' ||
      event.type === 'tool_unknown' ||
      event.type === 'tool_denied'
    ) {
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: String(event.payload.callId),
            toolName: String(event.payload.name),
            output: {
              type: 'text',
              value: `${event.type !== 'tool_finished' || Boolean(event.payload.isError) ? 'ERROR: ' : ''}${String(event.payload.output ?? '').slice(0, 12_000)}`,
            },
          },
        ],
      });
    }
  }
  return messages;
}
