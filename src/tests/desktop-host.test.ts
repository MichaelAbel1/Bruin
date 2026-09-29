import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import http from 'node:http';
import { SqliteEventStore } from '../storage/event-store.js';

test('desktop host manages models, sessions, recovery and skills over JSON lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-desktop-'));
  const script = fileURLToPath(new URL('../desktop-host.js', import.meta.url));
  let modelCalls = 0;
  const authHeaders: string[] = [];
  const server = http.createServer((req, response) => {
    if (req.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'test' }, { id: 'other' }] }));
      return;
    }
    authHeaders.push(String(req.headers.authorization ?? ''));
    modelCalls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta =
      modelCalls === 1
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'write-1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: '{"path":"result.txt","content":"created"}',
                },
              },
            ],
          }
        : { role: 'assistant', content: '完成，文件已创建。' };
    response.write(
      `data: ${JSON.stringify({ id: `reply-${modelCalls}`, object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: `reply-${modelCalls}`, object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: {}, finish_reason: modelCalls === 1 ? 'tool_calls' : 'stop' }] })}\n\n`,
    );
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, BRUIN_HOME: path.join(dir, 'home') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  let finishRun: (events: any[]) => void = () => {};
  let failRun: (error: Error) => void = () => {};
  let approvalSeen = 0;
  const runDone = new Promise<any[]>((resolve, reject) => {
    finishRun = resolve;
    failRun = reject;
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (!message.id) {
      if (message.type === 'approval') {
        approvalSeen++;
        void request('answerApproval', { approvalId: message.approvalId, approved: true });
      }
      if (message.type === 'runFinished') finishRun(message.events);
      if (message.type === 'runFailed') failRun(new Error(message.message));
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });
  function request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = String(Math.random());
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  try {
    const initial = await request('bootstrap');
    assert.deepEqual(initial.sessions, []);
    const key = 'sk-test-key-used-only-in-memory';
    const config = await request('saveProfile', {
      alias: 'local',
      provider: 'openai-compatible',
      model: 'test',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: key,
      contextWindowTokens: 65_536,
    });
    assert.equal(config.profiles[0].contextWindowTokens, 65_536);
    assert.equal(config.defaultProfile, 'local');
    await assert.rejects(
      request('saveProfile', { alias: 'bad', provider: 'openai', model: 'test', apiKeyEnv: key }),
      (error) => {
        assert.doesNotMatch(String(error), /sk-test-key/);
        return true;
      },
    );
    const created = await request('createSession', { workspace: dir });
    assert.equal(created.session.workspace, fs.realpathSync(dir));
    assert.equal(created.session.profile.alias, 'local');
    await assert.rejects(
      request('createSession', { workspace: path.join(dir, 'non_existent_subdir') }),
      /ENOENT/,
    );
    await assert.rejects(
      request('saveProfile', {
        alias: 'bad-url',
        provider: 'openai-compatible',
        model: 'test',
        baseUrl: 'not-a-valid-url',
      }),
      /Base URL 必须是以 http:\/\/ 或 https:\/\/ 开头的有效网址/,
    );
    fs.writeFileSync(path.join(dir, 'preview.txt'), 'preview content');
    assert.ok(
      (await request('listWorkspaceEntries', { sessionId: created.session.id })).some(
        (entry: { name: string }) => entry.name === 'preview.txt',
      ),
    );
    assert.equal(
      (
        await request('readWorkspaceFile', {
          sessionId: created.session.id,
          path: 'preview.txt',
        })
      ).content,
      'preview content',
    );
    await assert.rejects(
      request('readWorkspaceFile', {
        sessionId: created.session.id,
        path: '../outside',
      }),
      /路径超出工作区/,
    );
    const opened = await request('openSession', { sessionId: created.session.id });
    assert.deepEqual(opened.events, []);
    assert.deepEqual(await request('discoverModels', { alias: 'local' }), ['other', 'test']);
    const edited = await request('saveProfile', {
      alias: 'local',
      provider: 'openai-compatible',
      model: 'test-edited',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      contextWindowTokens: 49_152,
    });
    assert.equal(edited.profiles[0].model, 'test-edited');
    assert.equal(edited.profiles[0].contextWindowTokens, 49_152);
    const reopened = await request('openSession', { sessionId: created.session.id });
    assert.equal(reopened.session.profile.model, 'test-edited');
    assert.equal(reopened.session.profile.contextWindowTokens, 49_152);
    assert.equal(reopened.events.at(-1).type, 'model_switched');
    const switched = await request('setSessionModel', {
      sessionId: created.session.id,
      alias: 'local',
      modelId: 'other',
    });
    assert.equal(switched.session.profile.model, 'other');
    const switchCount = switched.events.length;
    const repeated = await request('setSessionModel', {
      sessionId: created.session.id,
      alias: 'local',
      modelId: 'other',
    });
    assert.equal(repeated.events.length, switchCount);
    await request('saveProfile', {
      alias: 'local',
      provider: 'openai-compatible',
      model: 'new-default',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    assert.equal(
      (await request('openSession', { sessionId: created.session.id })).session.profile.model,
      'other',
    );
    assert.equal(
      (await request('openSession', { sessionId: created.session.id })).events.length,
      switchCount,
    );
    const skillDir = path.join(dir, 'skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: example\ndescription: A local skill\n---\nInstructions.\n',
    );
    const skills = await request('installLocal', { directory: skillDir });
    assert.equal(skills.find((skill: { name: string }) => skill.name === 'example')?.enabled, true);
    assert.match(await request('readSkill', { name: 'example' }), /Instructions/);
    await assert.rejects(
      request('send', { sessionId: created.session.id, prompt: '' }),
      /消息不能为空/,
    );
    await request('send', { sessionId: created.session.id, prompt: '创建文件' });
    const events = await runDone;
    assert.equal(approvalSeen, 1);
    assert.equal(modelCalls, 2);
    assert.deepEqual(authHeaders, [`Bearer ${key}`, `Bearer ${key}`]);
    assert.doesNotMatch(
      fs.readFileSync(path.join(dir, 'home', 'config.json'), 'utf8'),
      /sk-test-key/,
    );
    assert.doesNotMatch(JSON.stringify(events), /sk-test-key/);
    assert.equal(fs.readFileSync(path.join(dir, 'result.txt'), 'utf8'), 'created');
    assert.ok(events.some((event) => event.type === 'tool_approved'));
    assert.equal(events.at(-1).type, 'turn_completed');

    const externalStore = new SqliteEventStore(path.join(dir, 'home', 'sessions.sqlite'));
    try {
      externalStore.acquireLease(created.session.id, 'external-process', 30_000);
      await assert.rejects(
        request('runtimeTool', {
          sessionId: created.session.id,
          name: 'list_memory',
          input: {},
        }),
        /运行/,
      );
      await assert.rejects(
        request('writeWorkspaceFile', {
          sessionId: created.session.id,
          path: 'leased.txt',
          content: 'hello',
        }),
        /此会话正在另一个进程中运行/,
      );
    } finally {
      externalStore.releaseLease(created.session.id, 'external-process');
      externalStore.close();
    }

    const writeRes = await request('writeWorkspaceFile', {
      sessionId: created.session.id,
      path: 'written.txt',
      content: 'hello written',
    });
    assert.equal(writeRes.path, 'written.txt');
    assert.equal(fs.readFileSync(path.join(dir, 'written.txt'), 'utf8'), 'hello written');

    const afterRemoval = await request('removeProfile', { alias: 'local' });
    assert.deepEqual(afterRemoval.profiles, []);
    assert.equal(afterRemoval.defaultProfile, undefined);
    assert.deepEqual(await request('deleteSession', { sessionId: created.session.id }), []);
    await assert.rejects(request('openSession', { sessionId: created.session.id }), /会话不存在/);
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop startup repairs a legacy session profile containing a key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-desktop-legacy-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const key = 'sk-test-legacy-session-key';
  const profile = {
    alias: 'legacy',
    provider: 'openai-compatible' as const,
    model: 'test',
    baseUrl: 'http://localhost:1234/v1',
    apiKeyEnv: key,
  };
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ profiles: [profile], defaultProfile: 'legacy', marketplaces: [] }),
  );
  const store = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
  const session = store.createSession(dir, profile);
  store.append(session.id, 'model_error', { message: `Missing API key: ${key}` });
  store.close();
  const script = fileURLToPath(new URL('../desktop-host.js', import.meta.url));
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, BRUIN_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const reply = new Promise<any>((resolve, reject) => {
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.id === 'boot')
          message.error ? reject(new Error(message.error)) : resolve(message.result);
      });
      child.once('error', reject);
    });
    child.stdin.write(JSON.stringify({ id: 'boot', method: 'bootstrap' }) + '\n');
    const boot = await reply;
    assert.equal(boot.sessions[0].id, session.id);
    assert.equal(boot.sessions[0].profile.apiKeyEnv, undefined);
    const opened = new Promise<any>((resolve, reject) => {
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.id === 'open')
          message.error ? reject(new Error(message.error)) : resolve(message.result);
      });
    });
    child.stdin.write(
      JSON.stringify({ id: 'open', method: 'openSession', params: { sessionId: session.id } }) +
        '\n',
    );
    const view = await opened;
    assert.doesNotMatch(JSON.stringify(view.events), /sk-test-legacy/);
    assert.doesNotMatch(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), /sk-test-legacy/);
    const reopened = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
    try {
      assert.equal(reopened.getSession(session.id)?.profile.apiKeyEnv, undefined);
    } finally {
      reopened.close();
    }
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop reviewUnknown precisely acknowledges specific sequence and requires review for new unknown events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-desktop-review-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const store = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
  const session = store.createSession(dir, {
    alias: 'test',
    provider: 'openai-compatible',
    model: 'test',
    baseUrl: 'http://localhost:1234/v1',
  });
  store.append(session.id, 'assistant', {
    text: '',
    calls: [{ id: 'c1', name: 'shell', input: {} }],
  });
  store.append(session.id, 'tool_unknown', {
    callId: 'c1',
    name: 'shell',
    output: 'interrupted 1',
  });
  store.close();

  const script = fileURLToPath(new URL('../desktop-host.js', import.meta.url));
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, BRUIN_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });
  function request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = String(Math.random());
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  try {
    const open1 = await request('openSession', { sessionId: session.id });
    assert.equal(open1.needsReview, true);

    const reviewed = await request('reviewUnknown', { sessionId: session.id });
    assert.equal(reviewed.needsReview, false);

    // Simulate another process or action producing a newer tool_unknown
    const store2 = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
    store2.append(session.id, 'assistant', {
      text: '',
      calls: [{ id: 'c2', name: 'shell', input: {} }],
    });
    store2.append(session.id, 'tool_unknown', {
      callId: 'c2',
      name: 'shell',
      output: 'interrupted 2',
    });
    store2.close();

    const open2 = await request('openSession', { sessionId: session.id });
    assert.equal(open2.needsReview, true);
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
