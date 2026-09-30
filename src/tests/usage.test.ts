import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedUsage, recordedTokenLabel } from '../core/usage.js';

test('recorded usage survives compaction and model switches without counting non-responses', () => {
  const events = [
    {
      type: 'assistant',
      payload: { usage: { inputTokens: 100, outputTokens: 20 }, profileAlias: 'first' },
    },
    { type: 'summary', payload: { throughSeq: 1, usage: { inputTokens: 999, outputTokens: 999 } } },
    { type: 'model_switched', payload: { profileAlias: 'second' } },
    {
      type: 'assistant',
      payload: { usage: { inputTokens: 200, outputTokens: 0 }, profileAlias: 'second' },
    },
    { type: 'tool_finished', payload: { usage: { inputTokens: 999 } } },
  ];
  const original = structuredClone(events);
  assert.deepEqual(recordedUsage(events), {
    responses: 2,
    inputTokens: 300n,
    outputTokens: 20n,
    inputReports: 2,
    outputReports: 2,
  });
  assert.deepEqual(events, original);
  assert.equal(recordedTokenLabel(300n, 2, 2), '300');
  assert.equal(recordedTokenLabel(0n, 2, 2), '0');
});

test('missing and malformed counts remain unknown while valid partial counts are retained', () => {
  const usage = recordedUsage([
    { type: 'assistant', payload: {} },
    { type: 'assistant', payload: { usage: { inputTokens: 0 } } },
    { type: 'assistant', payload: { usage: { inputTokens: -1, outputTokens: 3.5 } } },
    { type: 'assistant', payload: { usage: { inputTokens: '9', outputTokens: NaN } } },
    { type: 'assistant', payload: { usage: { inputTokens: Infinity, outputTokens: 2000 } } },
    { type: 'assistant', payload: { usage: [] } },
  ]);
  assert.deepEqual(usage, {
    responses: 6,
    inputTokens: 0n,
    outputTokens: 2000n,
    inputReports: 1,
    outputReports: 1,
  });
  assert.equal(recordedTokenLabel(usage.inputTokens, usage.inputReports, usage.responses), '≥ 0');
  assert.equal(
    recordedTokenLabel(usage.outputTokens, usage.outputReports, usage.responses),
    '≥ 2,000',
  );
  assert.equal(recordedTokenLabel(0n, 0, 6), '未提供');
  assert.deepEqual(recordedUsage([]), {
    responses: 0,
    inputTokens: 0n,
    outputTokens: 0n,
    inputReports: 0,
    outputReports: 0,
  });
});

test('accumulated token totals remain exact above the safe integer range', () => {
  const usage = recordedUsage([
    { type: 'assistant', payload: { usage: { inputTokens: Number.MAX_SAFE_INTEGER } } },
    { type: 'assistant', payload: { usage: { inputTokens: 2 } } },
    { type: 'assistant', payload: { usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1 } } },
  ]);
  assert.equal(usage.inputTokens, 9007199254740993n);
  assert.equal(usage.inputReports, 2);
  assert.equal(
    recordedTokenLabel(usage.inputTokens, usage.inputReports, usage.responses),
    '≥ 9,007,199,254,740,993',
  );
});
