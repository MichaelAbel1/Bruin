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
    });
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
    const opened = await request('openSession', { sessionId: created.session.id });
    assert.deepEqual(opened.events, []);
    const edited = await request('saveProfile', {
      alias: 'local',
      provider: 'openai-compatible',
      model: 'test-edited',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    assert.equal(edited.profiles[0].model, 'test-edited');
    const reopened = await request('openSession', { sessionId: created.session.id });
    assert.equal(reopened.session.profile.model, 'test-edited');
    assert.equal(reopened.events.at(-1).type, 'model_switched');
    const skillDir = path.join(dir, 'skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: example\ndescription: A local skill\n---\nInstructions.\n',
    );
    const skills = await request('installLocal', { directory: skillDir });
    assert.equal(skills[0].name, 'example');
    assert.equal(skills[0].enabled, true);
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
