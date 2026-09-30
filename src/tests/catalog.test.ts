import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discoverModels } from '../providers/catalog.js';
import { setRuntimeApiKey } from '../config.js';

test('model discovery protects its cache from caller mutations and rejects invalid JSON shapes', async (t) => {
  let body = JSON.stringify({ data: [{ id: 'first' }, { id: 'second' }] });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response(body);
  });
  const profile = {
    alias: 'cache-isolation-test',
    provider: 'openai-compatible' as const,
    model: 'first',
    baseUrl: 'http://127.0.0.1/cache-isolation-test',
  };
  const models = await discoverModels(profile, true);
  models.splice(0, models.length, 'caller-change');
  assert.deepEqual(await discoverModels(profile), ['first', 'second']);
  assert.equal(requests, 1);
  for (const value of [null, 42, [], 'invalid']) {
    body = JSON.stringify(value);
    await assert.rejects(discoverModels(profile, true), /模型列表格式不受支持/);
  }
});

test('discovers other models from a configured OpenAI-compatible API', async () => {
  const paths: string[] = [];
  const auth: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    auth.push(String(req.headers.authorization ?? ''));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'first' }, { id: 'second' }, { id: 'first' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  setRuntimeApiKey('catalog-test', 'test-only-key');
  try {
    const models = await discoverModels({
      alias: 'catalog-test',
      provider: 'openai-compatible',
      model: 'first',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    assert.deepEqual(models, ['first', 'second']);
    assert.deepEqual(paths, ['/v1/models']);
    assert.deepEqual(auth, ['Bearer test-only-key']);
  } finally {
    setRuntimeApiKey('catalog-test', undefined);
    server.close();
  }
});

test('model discovery uses provider-specific authentication and pagination', async () => {
  const seen: Array<{ path: string; key: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({
      path: req.url ?? '',
      key: String(req.headers['x-goog-api-key'] ?? req.headers['x-api-key'] ?? ''),
    });
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/google')) {
      res.end(
        req.url.includes('pageToken=next')
          ? JSON.stringify({
              models: [
                { name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] },
              ],
            })
          : JSON.stringify({
              models: [
                { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] },
              ],
              nextPageToken: 'next',
            }),
      );
    } else res.end(JSON.stringify({ data: [{ id: 'claude-a' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  setRuntimeApiKey('google-test', 'google-secret');
  setRuntimeApiKey('anthropic-test', 'anthropic-secret');
  try {
    const root = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(
      await discoverModels({
        alias: 'google-test',
        provider: 'google',
        model: 'gemini-a',
        baseUrl: `${root}/google`,
      }),
      ['gemini-a', 'gemini-b'],
    );
    assert.deepEqual(
      await discoverModels({
        alias: 'anthropic-test',
        provider: 'anthropic',
        model: 'claude-a',
        baseUrl: `${root}/anthropic`,
      }),
      ['claude-a'],
    );
    assert.deepEqual(seen, [
      { path: '/google/models', key: 'google-secret' },
      { path: '/google/models?pageToken=next', key: 'google-secret' },
      { path: '/anthropic/models', key: 'anthropic-secret' },
    ]);
  } finally {
    setRuntimeApiKey('google-test', undefined);
    setRuntimeApiKey('anthropic-test', undefined);
    server.close();
  }
});

test('model discovery never forwards credentials through redirects', async () => {
  let forwarded = false;
  const target = http.createServer((_req, res) => {
    forwarded = true;
    res.end('{}');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetAddress = target.address();
  if (!targetAddress || typeof targetAddress === 'string') throw new Error('no address');
  const source = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/models` });
    res.end();
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourceAddress = source.address();
  if (!sourceAddress || typeof sourceAddress === 'string') throw new Error('no address');
  setRuntimeApiKey('redirect-test', 'secret-for-redirect-test');
  try {
    await assert.rejects(
      discoverModels({
        alias: 'redirect-test',
        provider: 'openai-compatible',
        model: 'first',
        baseUrl: `http://127.0.0.1:${sourceAddress.port}/v1`,
      }),
      /网络错误、重定向或超时/,
    );
    assert.equal(forwarded, false);
  } finally {
    setRuntimeApiKey('redirect-test', undefined);
    source.close();
    target.close();
  }
});
