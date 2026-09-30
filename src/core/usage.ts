/** Project recorded responses only; missing provider counts are not zero usage. */
export function recordedUsage(
  events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
) {
  const totals = {
    responses: 0,
    inputTokens: 0n,
    outputTokens: 0n,
    inputReports: 0,
    outputReports: 0,
  };
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    totals.responses++;
    const usage = event.payload.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
    const counts = usage as Record<string, unknown>;
    for (const kind of ['input', 'output'] as const) {
      const value = counts[`${kind}Tokens`];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) continue;
      totals[`${kind}Tokens`] += BigInt(value);
      totals[`${kind}Reports`]++;
    }
  }
  return totals;
}

export function recordedTokenLabel(tokens: bigint, reports: number, responses: number): string {
  if (!reports) return '未提供';
  return `${reports < responses ? '≥ ' : ''}${tokens.toLocaleString('zh-CN')}`;
}
