import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { budgetPrompt, buildPrompt, promptBytes } from '../core/history.js';
import type { SessionEvent } from '../core/types.js';

function toolPair(id: string, output: string): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: id, toolName: 'read_file', input: { path: 'source.ts' } },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: id,
          toolName: 'read_file',
          output: { type: 'text', value: output },
        },
      ],
    },
  ];
}

test('history previews retain terminal error status at the end of large tool output', () => {
  const events: SessionEvent[] = [
    { sessionId: 'tail', seq: 1, type: 'user', at: '', payload: { text: 'run tests' } },
    {
      sessionId: 'tail',
      seq: 2,
      type: 'assistant',
      at: '',
      payload: { calls: [{ id: 'test', name: 'shell', input: { command: 'npm test' } }] },
    },
    {
      sessionId: 'tail',
      seq: 3,
      type: 'tool_finished',
      at: '',
      payload: {
        callId: 'test',
        name: 'shell',
        output: 'test-start\n' + 'passing\n'.repeat(5000) + 'FAIL: final assertion',
        isError: true,
      },
    },
  ];
  const result = JSON.stringify(buildPrompt(events, 'rules'));
  assert.match(result, /ERROR: test-start/);
  assert.match(result, /FAIL: final assertion/);
  assert.match(result, /中间内容已压缩/);
  assert.equal(String(events[2].payload.output).length > 12_000, true);
});

test('output compaction preserves prior goals and tool protocol before dropping turns', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'Keep architecture boundaries.' },
    { role: 'user', content: 'Important earlier decision: retain API compatibility.' },
    ...toolPair('read', 'header\n' + 'x'.repeat(20_000) + '\nfooter'),
    { role: 'user', content: 'Continue and verify.' },
  ];
  const original = JSON.stringify(messages);
  const result = budgetPrompt(messages, 8192);
  assert.ok(promptBytes(result) <= 6144);
  assert.equal(result.length, messages.length);
  assert.match(JSON.stringify(result), /retain API compatibility/);
  assert.match(JSON.stringify(result), /header.*footer/);
  assert.deepEqual(result[2], messages[2]);
  assert.equal(JSON.stringify(messages), original);
});

test('a long single turn retains the actual request alongside compacted activity', () => {
  const system = {
    role: 'system' as const,
    content: 'Global rules: do not change public interfaces.',
  };
  const user = { role: 'user' as const, content: '修复缓存并保留权限检查，执行测试。' };
  const messages = [
    system,
    user,
    ...Array.from({ length: 30 }, (_, i) => toolPair(`read-${i}`, '文件内容'.repeat(4000))).flat(),
  ];
  const original = JSON.stringify(messages);
  const result = budgetPrompt(messages, 8192);
  assert.ok(promptBytes(result) <= 6144);
  assert.deepEqual(result[0], system);
  assert.deepEqual(
    result.find((message) => message.role === 'user'),
    user,
  );
  assert.ok(
    result.some(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.includes('Recent tool activity'),
    ),
  );
  assert.equal(result.filter((message) => message.role === 'tool').length, 0);
  assert.equal(JSON.stringify(messages), original);
  const retried = budgetPrompt(result, 4096);
  assert.ok(promptBytes(retried) <= 3072);
  assert.deepEqual(
    retried.find((message) => message.role === 'user'),
    user,
  );
});

test('insufficient budgets reject instead of silently truncating system rules or dropping images', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'global rule\n' + '中'.repeat(3000) + '\nproject rule' },
    { role: 'user', content: 'current request' },
  ];
  assert.throws(() => budgetPrompt(messages, 8192), /上下文预算不足/);
  assert.match(String(messages[0].content), /project rule$/);
  assert.throws(
    () =>
      budgetPrompt(
        [
          { role: 'system', content: 'rules' },
          {
            role: 'user',
            content: [
              {
                type: 'image',
                image: new URL('data:image/png;base64,AAAA'),
                mediaType: 'image/png',
              },
            ],
          },
        ],
        8192,
      ),
    /上下文预算不足/,
  );
});

test('model switch before a checkpoint still prevents replaying old provider messages', () => {
  const event = (
    seq: number,
    type: SessionEvent['type'],
    payload: Record<string, unknown>,
  ): SessionEvent => ({ sessionId: 'switch', seq, type, at: '', payload });
  const result = buildPrompt(
    [
      event(1, 'user', { text: 'earlier request' }),
      event(2, 'user', { text: 'retained request' }),
      event(3, 'assistant', {
        text: 'neutral answer',
        calls: [],
        profileAlias: 'main',
        protocol: 'openai',
        providerMessages: [{ role: 'assistant', content: 'stale provider state' }],
      }),
      event(4, 'model_switched', {}),
      event(5, 'summary', { throughSeq: 1, text: 'earlier summary' }),
    ],
    'rules',
    'main',
    'openai',
  );
  assert.match(JSON.stringify(result), /neutral answer/);
  assert.doesNotMatch(JSON.stringify(result), /stale provider state/);
});
