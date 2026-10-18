type Sequenced = ReadonlyArray<{ seq: number }>;

/** Late RPC replies must not roll a live event view back or cross sessions.
 * Negative sequences are optimistic UI entries, not durable checkpoints. */
export function acceptsEventSnapshot(
  current: { session: { id: string }; events: Sequenced } | null,
  sessionId: string,
  incoming: Sequenced,
): boolean {
  if (!current || current.session.id !== sessionId) return false;
  const through = (events: Sequenced) =>
    events.reduce(
      (seq, event) => (Number.isSafeInteger(event.seq) && event.seq > seq ? event.seq : seq),
      0,
    );
  return through(incoming) >= through(current.events);
}
