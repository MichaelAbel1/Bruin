import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AiSdkGateway, modelProtocol, resolveApiKey } from '../providers/gateway.js';
import { setRuntimeApiKey } from '../config.js';

test('custom OpenAI base URL uses chat completions', async () => {
  let requestPath = '';
  const server = http.createServer((req, res) => {
    requestPath = req.url ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  setRuntimeApiKey('remote', 'test-only-key');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const profile = {
      alias: 'remote',
      provider: 'openai' as const,
      model: 'mock',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    };
    const reply = await new AiSdkGateway().complete(
      profile,
      [{ role: 'user', content: 'hi' }],
      new AbortController().signal,
      () => {},
    );
    assert.equal(requestPath, '/v1/chat/completions');
    assert.equal(reply.text, 'OK');
    assert.equal(modelProtocol(profile), 'openai-chat');
    assert.equal(
      modelProtocol({ alias: 'official', provider: 'openai', model: 'gpt-4.1' }),
      'openai-responses',
    );
  } finally {
    setRuntimeApiKey('remote', undefined);
    server.close();
  }
});

test('text encoded think blocks do not reach streaming UI or final answer', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const content of ['<thi', 'nk>private reasoning', '</think>', 'Final answer'])
      res.write(
        `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
      );
    res.write(
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  let streamed = '';
  try {
    const reply = await new AiSdkGateway().complete(
      {
        alias: 'think-test',
        provider: 'openai-compatible',
        model: 'mock',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
      [{ role: 'user', content: 'hi' }],
      new AbortController().signal,
      (delta) => {
        streamed += delta;
      },
    );
    assert.equal(streamed, 'Final answer');
    assert.equal(reply.text, streamed);
  } finally {
    server.close();
  }
});

test('OpenAI-compatible SSE stream is normalized', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = [
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null },
        ],
      },
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
      },
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ];
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    let streamed = '';
    const reply = await new AiSdkGateway().complete(
      {
        alias: 'mock',
        provider: 'openai-compatible',
        model: 'mock',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
      [{ role: 'user', content: 'hi' }],
      new AbortController().signal,
      (text) => {
        streamed += text;
      },
    );
    assert.equal(reply.text, 'Hello world');
    assert.equal(streamed, reply.text);
    assert.deepEqual(reply.calls, []);
  } finally {
    server.close();
  }
});
test('OpenAI-compatible streamed tool call is normalized', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = [
      {
        id: '2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: '2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"x.txt"}' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: '2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ];
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const reply = await new AiSdkGateway().complete(
      {
        alias: 'mock',
        provider: 'openai-compatible',
        model: 'mock',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
      [{ role: 'user', content: 'read x' }],
      new AbortController().signal,
      () => {},
    );
    assert.deepEqual(reply.calls, [{ id: 'call1', name: 'read_file', input: { path: 'x.txt' } }]);
  } finally {
    server.close();
  }
});

test('modelProtocol safely handles malformed baseUrl without crashing', () => {
  assert.equal(
    modelProtocol({
      alias: 'custom',
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: 'not-a-valid-url',
    }),
    'openai-chat',
  );
  assert.equal(
    modelProtocol({
      alias: 'standard',
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
    }),
    'openai-responses',
  );
});

test('resolveApiKey allows local 0.0.0.0 endpoints without API key', () => {
  const profile = {
    alias: 'local-docker',
    provider: 'openai-compatible' as const,
    model: 'llama3',
    baseUrl: 'http://0.0.0.0:11434/v1',
  };
  assert.equal(resolveApiKey(profile), undefined);
});
