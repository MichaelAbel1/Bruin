export type SessionEvent = {
  seq: number;
  type: string;
  at: string;
  payload: Record<string, unknown>;
};

type ConversationItem =
  { kind: 'event'; event: SessionEvent } | { kind: 'tools'; events: SessionEvent[] };

export function groupConversationEvents(events: SessionEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let tools: SessionEvent[] = [];
  const flush = () => {
    if (tools.length) items.push({ kind: 'tools', events: tools });
    tools = [];
  };
  for (const event of events) {
    if (event.type === 'assistant') {
      if (String(event.payload.text ?? '').trim()) {
        flush();
        items.push({ kind: 'event', event });
      }
      if (Array.isArray(event.payload.calls) && event.payload.calls.length) tools.push(event);
    } else if (['tool_finished', 'tool_denied', 'tool_unknown'].includes(event.type)) {
      tools.push(event);
    } else if (
      event.type === 'user' ||
      event.type === 'model_error' ||
      event.type === 'turn_paused' ||
      event.type === 'turn_checkpoint' ||
      (event.type === 'run_configured' && Number(event.payload.maxModelCalls) > 24)
    ) {
      flush();
      items.push({ kind: 'event', event });
    }
  }
  flush();
  return items;
}
