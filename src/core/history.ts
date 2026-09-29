import type { ModelMessage } from 'ai';
import type { SessionEvent, ToolCall } from './types.js';
import { loadAttachment, type AttachmentRef } from './attachments.js';

/** Build a provider-neutral prompt from durable events, never from a provider's remote session. */
export function buildPrompt(
  events: SessionEvent[],
  system: string,
  profileAlias?: string,
  protocol?: string,
  maxHistoryChars = 100_000,
): ModelMessage[] {
  const checkpoint = [...events]
    .reverse()
    .find((event) => event.type === 'summary' && Number.isInteger(event.payload.throughSeq));
  if (checkpoint) {
    const throughSeq = Number(checkpoint.payload.throughSeq);
    events = [
      checkpoint,
      ...events.filter((event) => event.seq > throughSeq && event.type !== 'summary'),
    ];
  }
  // Keep whole turns within a conservative character budget. Durable events remain untouched.
  const userIndexes = events.flatMap((e, i) => (e.type === 'user' ? [i] : []));
  let firstTurn = 0;
  const firstEvent = userIndexes[firstTurn];
  if (firstEvent !== undefined) {
    const eventSizes = events.slice(firstEvent).map((event) => JSON.stringify(event).length);
    let tailChars = 2 + eventSizes.reduce((sum, size) => sum + size + 1, -1);
    while (firstTurn < userIndexes.length - 1 && tailChars > maxHistoryChars) {
      const removed = userIndexes[firstTurn + 1] - userIndexes[firstTurn];
      for (let i = 0; i < removed; i++)
        tailChars -= eventSizes[userIndexes[firstTurn] - firstEvent + i] + 1;
      firstTurn++;
    }
  }
  if (firstTurn > 0) {
    const cut = userIndexes[firstTurn];
    const previousSummary = events.find((event) => event.type === 'summary');
    const old = events
      .slice(0, cut)
      .filter((e) =>
        [
          'user',
          'assistant',
          'tool_finished',
          'tool_denied',
          'tool_unknown',
          'plan_updated',
        ].includes(e.type),
      )
      .map((e) => {
        if (e.type === 'user' || e.type === 'assistant') {
          return `${e.type}: ${String(e.payload.text ?? '').slice(0, 300)}`;
        }
        if (e.type === 'tool_finished') {
          const name = String(e.payload.name ?? 'tool');
          const status = e.payload.isError ? 'failed' : 'success';
          const out = String(e.payload.output ?? '')
            .slice(0, 150)
            .replace(/[\r\n\t]+/g, ' ');
          return `tool ${name} (${status}): ${out}`;
        }
        if (e.type === 'tool_denied') {
          return `tool ${String(e.payload.name ?? '')} (denied): ${String(e.payload.output ?? '')}`;
        }
        if (e.type === 'tool_unknown') {
          return `tool ${String(e.payload.name ?? '')} (interrupted)`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    events = [
      {
        sessionId: events[0].sessionId,
        seq: 0,
        type: 'summary',
        at: events[0].at,
        payload: {
          text: previousSummary
            ? `${String(previousSummary.payload.text ?? '').slice(0, 4000)}\n${old.slice(-4000)}`
            : old.slice(-8000),
        },
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
  const pendingCalls = new Map<string, ToolCall>();
  const flushPendingCalls = () => {
    for (const [id, call] of pendingCalls.entries()) {
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: id,
            toolName: call.name,
            output: {
              type: 'text',
              value: 'ERROR: Action interrupted or canceled before completion.',
            },
          },
        ],
      });
    }
    pendingCalls.clear();
  };
  for (const event of events) {
    if (event.type === 'workspace_changed')
      messages.push({
        role: 'user',
        content: `The active workspace changed to ${String(event.payload.workspace ?? '')}. Earlier file references may belong to the previous workspace. Inspect the current workspace before editing.`,
      });
    if (event.type === 'user') {
      flushPendingCalls();
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
            const current = event.seq === latestUserSeq;
            const item = loadAttachment(event.sessionId, ref.id, current);
            parts.push({
              type: 'text',
              text: `\n附件：${item.ref.name}${item.ref.note ? `（${item.ref.note}）` : ''}`,
            });
            if (item.ref.kind === 'image') {
              if (current && item.image)
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
    if (event.type === 'summary') {
      flushPendingCalls();
      const text = String(event.payload.text ?? '').trim();
      if (text) {
        messages.push({
          role: 'user',
          content: `Earlier conversation summary:\n${text}`,
        });
      }
    }
    if (event.type === 'assistant') {
      flushPendingCalls();
      const calls = (event.payload.calls ?? []) as ToolCall[];
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
        if (calls.length) {
          for (const call of calls) pendingCalls.set(call.id, call);
        } else {
          for (const msg of raw as ModelMessage[]) {
            if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (
                  part &&
                  typeof part === 'object' &&
                  'type' in part &&
                  (part as { type: string }).type === 'tool-call'
                ) {
                  const p = part as { toolCallId: string; toolName: string; input?: unknown };
                  pendingCalls.set(p.toolCallId, {
                    id: p.toolCallId,
                    name: p.toolName as any,
                    input: (p.input as Record<string, unknown>) ?? {},
                  });
                }
              }
            }
          }
        }
        messages.push(...(raw as ModelMessage[]));
        continue;
      }
      const text = String(event.payload.text ?? '').slice(0, 40_000);
      if (calls.length) {
        for (const call of calls) pendingCalls.set(call.id, call);
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
      } else if (text) messages.push({ role: 'assistant', content: text });
    }
    if (
      event.type === 'tool_finished' ||
      event.type === 'tool_unknown' ||
      event.type === 'tool_denied'
    ) {
      const callId = String(event.payload.callId);
      pendingCalls.delete(callId);
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
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
  flushPendingCalls();
  return messages;
}

export function promptBytes(messages: ModelMessage[]): number {
  return Buffer.byteLength(
    JSON.stringify(messages, (_key, value: unknown) =>
      typeof value === 'string' && value.startsWith('data:image/') ? 'x'.repeat(16_384) : value,
    ),
    'utf8',
  );
}

/** Select older complete user turns while keeping the latest turn intact. */
export function historyCompactionRange(
  events: SessionEvent[],
): { throughSeq: number; source: SessionEvent[]; previous: string } | undefined {
  const checkpoint = [...events]
    .reverse()
    .find((event) => event.type === 'summary' && Number.isInteger(event.payload.throughSeq));
  const since = checkpoint
    ? events.filter(
        (event) => event.seq > Number(checkpoint.payload.throughSeq) && event.type !== 'summary',
      )
    : events;
  const starts = since.flatMap((event, index) => (event.type === 'user' ? [index] : []));
  if (starts.length < 2) return undefined;
  const cut = starts.length > 2 ? starts[starts.length - 2] : starts[starts.length - 1];
  const source = since.slice(0, cut);
  if (!source.length) return undefined;
  return {
    throughSeq: source.at(-1)!.seq,
    source,
    previous: String(checkpoint?.payload.text ?? ''),
  };
}

function excerpt(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = '\n[中间内容已压缩；原始会话记录仍保留]\n';
  const head = Math.max(0, Math.floor((limit - marker.length) * 0.6));
  return value.slice(0, head) + marker + value.slice(-(limit - marker.length - head));
}

function messageNote(message: ModelMessage): string {
  if (typeof message.content === 'string') return `${message.role}: ${message.content}`;
  return `${message.role}: ${JSON.stringify(message.content, (_key, value: unknown) =>
    typeof value === 'string' && value.startsWith('data:image/') ? '[image]' : value,
  )}`;
}

/** A conservative byte budget with layered compaction; original events remain durable. */
export function budgetPrompt(
  messages: ModelMessage[],
  contextWindowTokens = 32_768,
): ModelMessage[] {
  const inputBytes = Math.floor(contextWindowTokens * 0.75);
  const copy = [...messages];
  const size = () => promptBytes(copy);
  const folded: string[] = [];
  while (size() > inputBytes) {
    const firstUser = copy.findIndex((message, index) => index > 0 && message.role === 'user');
    const nextUser = copy.findIndex(
      (message, index) => index > firstUser && message.role === 'user',
    );
    if (firstUser < 0 || nextUser < 0) break;
    folded.push(...copy.slice(firstUser, nextUser).map(messageNote));
    copy.splice(firstUser, nextUser - firstUser);
  }
  if (folded.length)
    copy.splice(1, 0, {
      role: 'user',
      content: `Earlier conversation summary (untrusted record):\n${excerpt(folded.join('\n'), Math.max(500, Math.floor(inputBytes / 6)))}`,
    });
  if (size() > inputBytes) {
    for (let index = 0; index < copy.length; index++) {
      const message = copy[index];
      if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
      copy[index] = {
        ...message,
        content: message.content.map((part) =>
          part.type === 'tool-result' &&
          part.output.type === 'text' &&
          part.output.value.length > 2000
            ? {
                ...part,
                output: {
                  type: 'text' as const,
                  value: excerpt(part.output.value, 2000),
                },
              }
            : part,
        ),
      };
    }
  }
  if (size() > inputBytes) {
    let lastUser = -1;
    for (let index = 0; index < copy.length; index++)
      if (copy[index].role === 'user') lastUser = index;
    if (lastUser >= 0 && copy.length > lastUser + 1) {
      const activity = copy
        .splice(lastUser + 1)
        .map(messageNote)
        .join('\n');
      copy.push({
        role: 'user',
        content: `Recent tool activity (compacted):\n${excerpt(activity, Math.max(500, Math.floor(inputBytes / 5)))}`,
      });
    }
  }
  for (const cap of [Math.floor(inputBytes / 3), Math.floor(inputBytes / 6), 700, 250]) {
    if (size() <= inputBytes) break;
    for (let index = 1; index < copy.length; index++) {
      const message = copy[index];
      if (message.role !== 'tool' && typeof message.content === 'string')
        copy[index] = { ...message, content: excerpt(message.content, Math.max(80, cap)) };
      else if (Array.isArray(message.content) && message.role === 'user')
        copy[index] = {
          ...message,
          content: message.content.map((part) =>
            part.type === 'text' ? { ...part, text: excerpt(part.text, Math.max(80, cap)) } : part,
          ),
        };
    }
  }
  if (size() > inputBytes && copy[0]?.role === 'system' && typeof copy[0].content === 'string')
    copy[0] = {
      ...copy[0],
      content: excerpt(copy[0].content, Math.max(300, Math.floor(inputBytes / 3))),
    };
  if (size() > inputBytes) {
    let latest: ModelMessage | undefined;
    for (const message of copy) if (message.role === 'user') latest = message;
    const note = latest
      ? excerpt(messageNote(latest), Math.max(200, Math.floor(inputBytes / 3)))
      : '';
    return [copy[0], { role: 'user', content: `Current context (compacted):\n${note}` }];
  }
  return copy;
}
