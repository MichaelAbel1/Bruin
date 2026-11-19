import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (workspace, relative) => import(pathToFileURL(path.join(workspace, relative)).href);

const batchSource = `export function takeBatch(items, offset = 0, limit = 25) {
  const start = offset >= items.length ? 0 : offset;
  const end = start + limit;
  return { items: items.slice(start, end), nextOffset: end < items.length ? end : null };
}
`;

const quotaSource = `export function createQuota(limit) {
  let used = 0;
  return {
    consume(bytes) {
      if (used + bytes > limit) return false;
      used += bytes;
      return true;
    },
    snapshot() {
      return { limit, used, remaining: limit - used };
    },
  };
}
`;

const reportSource = `export function formatQuota(quota) {
  const { limit, used, remaining } = quota.snapshot();
  return \`\${used}/\${limit} used, \${remaining} available\`;
}
`;

export const cases = new Map([
  [
    'batch-end',
    {
      prompt:
        '修复 src/batches.mjs 的 takeBatch。offset 到达或超过列表尾时，应返回空列表和 null 的 nextOffset，而不是回到第一批。保留 offset 为 0、尾部不足一批和输入数组不被修改的行为。保留现有用户注释及 operator-notes.txt。',
      files: { 'src/batches.mjs': batchSource },
      edits: {
        'src/batches.mjs': `// Operator note: keep offsets zero-based.\n${batchSource}`,
        'operator-notes.txt': 'User note: compare results before publishing.\n',
      },
      protected: {
        'src/batches.mjs': { line: '// Operator note: keep offsets zero-based.' },
        'operator-notes.txt': { exact: 'User note: compare results before publishing.\n' },
      },
      async verify(workspace) {
        const { takeBatch } = await load(workspace, 'src/batches.mjs');
        const items = ['a', 'b', 'c'];
        assert.deepEqual(takeBatch(items, 0, 2), { items: ['a', 'b'], nextOffset: 2 });
        assert.deepEqual(takeBatch(items, 2, 2), { items: ['c'], nextOffset: null });
        assert.deepEqual(takeBatch(items, 3, 2), { items: [], nextOffset: null });
        assert.deepEqual(takeBatch(items, 99, 2), { items: [], nextOffset: null });
        assert.deepEqual(takeBatch([], 0, 2), { items: [], nextOffset: null });
        assert.deepEqual(items, ['a', 'b', 'c']);
      },
    },
  ],
  [
    'quota-reservation',
    {
      prompt: [
        '在 src/quota.mjs 与 src/report.mjs 中加入请求配额预留。',
        'reserve(bytes) 预留正整数个字节，数量不是正整数或剩余配额不足时返回 null。成功时返回带 commit() 和 release() 的句柄。',
        'commit() 将预留转为已用，release() 只释放预留；同一句柄只有第一次操作生效，后续调用返回 false，首次返回 true。',
        '原有 consume(bytes) 应考虑所有未结算的预留；snapshot() 返回 { limit, used, reserved, remaining }。',
        'formatQuota 输出 "2/10 used, 3 reserved, 5 available" 这样的格式。保留已有报告注释和用户 README。',
      ].join('\n'),
      files: {
        'src/quota.mjs': quotaSource,
        'src/report.mjs': reportSource,
        'README.md': '# Request quota\n',
      },
      edits: {
        'src/report.mjs': `// Operator note: the values in this report are bytes.\n${reportSource}`,
        'README.md': '# Request quota\n\nUser note: keep the existing API synchronous.\n',
      },
      protected: {
        'src/report.mjs': { line: '// Operator note: the values in this report are bytes.' },
        'README.md': {
          exact: '# Request quota\n\nUser note: keep the existing API synchronous.\n',
        },
      },
      async verify(workspace) {
        const { createQuota } = await load(workspace, 'src/quota.mjs');
        const { formatQuota } = await load(workspace, 'src/report.mjs');
        const quota = createQuota(10);
        assert.equal(quota.reserve(0), null);
        assert.equal(quota.reserve(-1), null);
        assert.equal(quota.reserve(1.5), null);
        assert.equal(quota.consume(2), true);
        const first = quota.reserve(3);
        assert.ok(first);
        assert.equal(formatQuota(quota), '2/10 used, 3 reserved, 5 available');
        assert.equal(quota.reserve(6), null);
        assert.equal(quota.consume(6), false);
        const second = quota.reserve(5);
        assert.ok(second);
        assert.deepEqual(quota.snapshot(), { limit: 10, used: 2, reserved: 8, remaining: 0 });
        assert.equal(first.commit(), true);
        assert.equal(first.release(), false);
        assert.equal(second.release(), true);
        assert.equal(second.commit(), false);
        assert.deepEqual(quota.snapshot(), { limit: 10, used: 5, reserved: 0, remaining: 5 });
        assert.equal(quota.consume(5), true);
        assert.equal(formatQuota(quota), '10/10 used, 0 reserved, 0 available');
      },
    },
  ],
]);
