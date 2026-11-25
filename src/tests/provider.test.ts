import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AiSdkGateway, modelProtocol, resolveApiKey } from '../providers/gateway.js';
import { setRuntimeApiKey } from '../config.js';
import type { ModelMessage } from 'ai';

test('Anthropic resumes after an assistant reply without prefilling its next reply', async (t) => {
  const requestMessages: Array<
    Array<{ role: string; content: Array<{ type: string; text?: string }> }>
  > = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const messages = JSON.parse(String(options.body)).messages;
    requestMessages.push(messages);
    if (messages.at(-1)?.role === 'assistant')
      return Response.json(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Assistant prefill unsupported' },
        },
        { status: 400 },
      );
    const message = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-6',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    };
    const events = [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Summary ready' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  });
  const profile = {
    alias: 'anthropic-continue',
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4-6',
    baseUrl: 'https://fixture.invalid/v1',
  };
  setRuntimeApiKey(profile.alias, 'test-only-key');
  try {
    const gateway = new AiSdkGateway();
    const complete = (messages: ModelMessage[]) =>
      gateway.complete(profile, messages, new AbortController().signal, () => {});
    const previous: ModelMessage[] = [
      { role: 'user', content: 'Summarize the research' },
      { role: 'assistant', content: 'Waiting for research' },
    ];
    assert.equal((await complete(previous)).text, 'Summary ready');
    assert.equal(previous.length, 2);
    assert.deepEqual(
      requestMessages[0].map((message) => message.role),
      ['user', 'assistant', 'user'],
    );
    assert.equal(requestMessages[0][1].content[0].text, 'Waiting for research');
    await complete([...previous, { role: 'user', content: 'Include the command output' }]);
    assert.equal(requestMessages[1].at(-1)?.content[0].text, 'Include the command output');
    await complete([
      previous[0],
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'read-note',
            toolName: 'read_file',
            input: { path: 'note.txt' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'read-note',
            toolName: 'read_file',
            output: { type: 'text', value: 'recorded tool output' },
          },
        ],
      },
    ]);
    const last = requestMessages[2].at(-1);
    assert.equal(last?.role, 'user');
    assert.deepEqual(
      last?.content.map((block) => block.type),
      ['tool_result'],
    );
    assert.match(JSON.stringify(last), /recorded tool output/);
  } finally {
    setRuntimeApiKey(profile.alias, undefined);
  }
});

test('gateway leaves transient HTTP retries to AgentRunner', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'temporary overload' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    await assert.rejects(
      new AiSdkGateway().complete(
        {
          alias: 'retry-test',
          provider: 'openai-compatible',
          model: 'mock',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
        [{ role: 'user', content: 'hello' }],
        new AbortController().signal,
        () => {},
      ),
    );
    assert.equal(requests, 1);
    await assert.rejects(
      new AiSdkGateway().summarize(
        {
          alias: 'retry-test',
          provider: 'openai-compatible',
          model: 'mock',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
        'Summarize these test events.',
        256,
        new AbortController().signal,
      ),
    );
    assert.equal(requests, 2);
  } finally {
    server.close();
  }
});

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

test('modelProtocol routes api.openai.com to openai-responses and throws on malformed url', () => {
  assert.equal(
    modelProtocol({
      alias: 'standard',
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
    }),
    'openai-responses',
  );
  assert.equal(
    modelProtocol({
      alias: 'custom',
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://gateway.ai.corp/v1',
    }),
    'openai-chat',
  );
  assert.throws(
    () =>
      modelProtocol({
        alias: 'bad',
        provider: 'openai',
        model: 'gpt-4o',
        baseUrl: 'not-a-valid-url',
      }),
    /Invalid URL/,
  );
});

test('resolveApiKey validates local URLs strictly against host spoofing and excludes 0.0.0.0', () => {
  const localProfile = {
    alias: 'local-ollama',
    provider: 'openai-compatible' as const,
    model: 'llama3',
    baseUrl: 'http://127.0.0.1:11434/v1',
  };
  assert.equal(resolveApiKey(localProfile), undefined);

  const ipv6Profile = {
    alias: 'local-ipv6',
    provider: 'openai-compatible' as const,
    model: 'llama3',
    baseUrl: 'http://[::1]:11434/v1',
  };
  assert.equal(resolveApiKey(ipv6Profile), undefined);

  // 0.0.0.0 is for binding, not client targeting; requires api key
  const zeroProfile = {
    alias: 'zero-host',
    provider: 'openai-compatible' as const,
    model: 'llama3',
    baseUrl: 'http://0.0.0.0:11434/v1',
  };
  assert.throws(() => resolveApiKey(zeroProfile), /缺少 API Key 环境变量/);

  // Userinfo spoofing http://localhost:443@evil.example/v1 resolves hostname to evil.example, not local
  const spoofedProfile = {
    alias: 'spoofed',
    provider: 'openai-compatible' as const,
    model: 'llama3',
    baseUrl: 'http://localhost:443@evil.example/v1',
  };
  assert.throws(() => resolveApiKey(spoofedProfile), /缺少 API Key 环境变量/);
});

test('think tag filter handles stray angle brackets before <think> and </think>', async (t) => {
  const runChunks = async (deltas: string[]) => {
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      const body =
        deltas
          .map(
            (content, index) =>
              `data: ${JSON.stringify({
                id: String(index + 1),
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock',
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
              })}\n\n`,
          )
          .join('') +
        `data: ${JSON.stringify({
          id: 'done',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    try {
      let streamed = '';
      const reply = await new AiSdkGateway().complete(
        {
          alias: 'think-edge',
          provider: 'openai-compatible',
          model: 'mock',
          baseUrl: 'http://127.0.0.1:1/v1',
        },
        [{ role: 'user', content: 'hi' }],
        new AbortController().signal,
        (delta) => {
          streamed += delta;
        },
      );
      assert.equal(reply.text, streamed);
      return reply.text;
    } finally {
      mock.mock.restore();
    }
  };

  assert.equal(await runChunks(['<think>x < y </t</think>', 'Visible answer']), 'Visible answer');
  assert.equal(await runChunks(['<<think>secret</think>Shown']), '<Shown');
});
