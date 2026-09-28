import type { ModelMessage } from 'ai';
import type { SessionEvent, ToolCall } from './types.js';
import { loadAttachment, type AttachmentRef } from './attachments.js';

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
  const latestUserSeq = events.reduce(
    (seq, event) => (event.type === 'user' ? Math.max(seq, event.seq) : seq),
    0,
  );
  let remainingOldAttachmentText = 20_000;
  let remainingCurrentAttachmentText = 60_000;
  for (const event of events) {
    if (event.type === 'workspace_changed')
      messages.push({
        role: 'user',
        content: `The active workspace changed to ${String(event.payload.workspace ?? '')}. Earlier file references may belong to the previous workspace. Inspect the current workspace before editing.`,
      });
    if (event.type === 'user') {
      const quote = event.payload.quote as { text?: string; seq?: number } | undefined;
      const intro = `${quote?.text ? `引用本会话第 ${quote.seq} 条消息：\n${quote.text}\n\n` : ''}${String(event.payload.text ?? '')}`;
      const refs = Array.isArray(event.payload.attachments)
        ? (event.payload.attachments as AttachmentRef[])
        : [];
      if (!refs.length) messages.push({ role: 'user', content: intro });
      else {
        const parts: Array<
          { type: 'text'; text: string } | { type: 'image'; image: URL; mediaType: string }
        > = [{ type: 'text', text: intro || '请查看这些附件。' }];
        for (const ref of refs.slice(0, 30)) {
          try {
            const item = loadAttachment(event.sessionId, ref.id);
            parts.push({
              type: 'text',
              text: `\n附件：${item.ref.name}${item.ref.note ? `（${item.ref.note}）` : ''}`,
            });
            if (item.image) {
              if (event.seq === latestUserSeq)
                parts.push({
                  type: 'image',
                  image: new URL(
                    `data:${item.image.mimeType};base64,${item.image.data.toString('base64')}`,
                  ),
                  mediaType: item.image.mimeType,
                });
              else
                parts.push({
                  type: 'text',
                  text: '之前的图片内容未重复发送；如需再次分析，请重新附上。',
                });
            } else if (item.text) {
              const current = event.seq === latestUserSeq;
              const content = item.text.slice(
                0,
                current ? remainingCurrentAttachmentText : remainingOldAttachmentText,
              );
              parts.push({ type: 'text', text: content });
              if (current) remainingCurrentAttachmentText -= content.length;
              else remainingOldAttachmentText -= content.length;
            }
          } catch {
            parts.push({ type: 'text', text: `附件 ${ref.name} 已不可读取` });
          }
        }
        messages.push({ role: 'user', content: parts });
      }
    }
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
