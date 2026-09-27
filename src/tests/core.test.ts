import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteEventStore } from '../storage/event-store.js';
import { buildPrompt } from '../core/history.js';
import { decisionFor } from '../core/permissions.js';
import { AgentRunner } from '../core/agent.js';
import type { ModelGateway } from '../providers/gateway.js';
import type { ToolExecutor } from '../executor/client.js';
import type { ModelProfile, ToolResult } from '../core/types.js';
import { ProcessExecutor } from '../executor/client.js';
import { installLocal, listSkills, loadSkill } from '../skills/registry.js';
import { getRuntimeApiKey, loadConfig, setRuntimeApiKey } from '../config.js';

const profile: ModelProfile = {
  alias: 'mock',
  provider: 'openai-compatible',
  model: 'mock',
  baseUrl: 'http://localhost:9999/v1',
};
function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-test-'));
}
test('SQLite event ordering and durable restart', () => {
  const dir = temp();
  const db = path.join(dir, 'events.sqlite');
  let store = new SqliteEventStore(db);
  const session = store.createSession(dir, profile);
  store.append(session.id, 'user', { text: 'hello' });
  store.append(session.id, 'assistant', { text: 'hi', calls: [] });
  store.close();
  store = new SqliteEventStore(db);
  assert.deepEqual(
    store.events(session.id).map((e) => e.seq),
    [1, 2],
  );
  assert.equal(store.getSession(session.id)?.profile.model, 'mock');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('model switch updates profile and event together', () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  const next: ModelProfile = { alias: 'second', provider: 'anthropic', model: 'example' };
  store.setProfile(session.id, next);
  assert.deepEqual(store.getSession(session.id)?.profile, next);
  assert.deepEqual(
    store.events(session.id).map((e) => e.type),
    ['model_switched'],
  );
  assert.deepEqual(store.events(session.id)[0].payload.profile, next);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('legacy key entered as environment name is migrated out of config', () => {
  const dir = temp();
  const originalHome = process.env.BRUIN_HOME;
  const key = 'sk-test-legacy-key-value';
  process.env.BRUIN_HOME = dir;
  try {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        profiles: [{ ...profile, apiKeyEnv: key }],
        defaultProfile: profile.alias,
        marketplaces: [],
      }),
    );
    const config = loadConfig();
    assert.equal(config.profiles[0].apiKeyEnv, undefined);
    assert.equal(getRuntimeApiKey(profile.alias), key);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), /sk-test-legacy/);
  } finally {
    setRuntimeApiKey(profile.alias, undefined);
    if (originalHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = originalHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('model switch discards old provider-specific message format', () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, profile);
    store.append(session.id, 'assistant', {
      text: 'Earlier answer',
      profileAlias: profile.alias,
      providerMessages: [{ role: 'assistant', content: 'provider-specific old message' }],
    });
    store.setProfile(session.id, { ...profile, model: 'new-model' });
    const prompt = buildPrompt(store.events(session.id), 'system', profile.alias);
    assert.deepEqual(prompt.at(-1), { role: 'assistant', content: 'Earlier answer' });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('uncertain tool call is reconciled once and not replayed', () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  store.append(session.id, 'assistant', {
    text: '',
    calls: [{ id: 'c1', name: 'write_file', input: { path: 'x', content: 'a' } }],
  });
  const gateway: ModelGateway = {
    async complete() {
      throw new Error('should not call');
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      throw new Error('should not execute');
    },
    async close() {},
  };
  const runner = new AgentRunner(store, gateway, executor, {
    text() {},
    notice() {},
    async approve() {
      return false;
    },
  });
  assert.equal(runner.recover(session), 1);
  assert.equal(runner.recover(session), 0);
  assert.equal(store.events(session.id).at(-1)?.type, 'tool_unknown');
  const prompt = buildPrompt(store.events(session.id), 'system');
  assert.equal(prompt.at(-1)?.role, 'tool');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('permission boundary denies escaped and symlinked reads', () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'inside'), 'a');
  fs.symlinkSync('/etc/hosts', path.join(dir, 'outside'));
  assert.equal(
    decisionFor({ id: '1', name: 'read_file', input: { path: 'inside' } }, dir).decision,
    'allow',
  );
  assert.equal(
    decisionFor({ id: '2', name: 'read_file', input: { path: 'outside' } }, dir).decision,
    'deny',
  );
  assert.equal(
    decisionFor({ id: '3', name: 'read_file', input: { path: '../etc/passwd' } }, dir).decision,
    'deny',
  );
  assert.equal(
    decisionFor({ id: '4', name: 'shell', input: { command: 'ls' } }, dir).decision,
    'ask',
  );
  assert.equal(
    decisionFor({ id: '5', name: 'write_file', input: { path: '../escape', content: 'x' } }, dir)
      .decision,
    'deny',
  );
  assert.equal(
    decisionFor({ id: '6', name: 'write_file', input: { path: 'outside', content: 'x' } }, dir)
      .decision,
    'deny',
  );
  assert.equal(
    decisionFor({ id: '7', name: 'write_file', input: { path: 'new.txt', content: 'x' } }, dir)
      .decision,
    'ask',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
test('executor runs in child process and enforces path restrictions', async () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const executor = new ProcessExecutor();
  try {
    const good = await executor.execute({
      requestId: 'a',
      name: 'read_file',
      input: { path: 'a.txt' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    assert.equal(good.output, 'hello');
    const bad = await executor.execute({
      requestId: 'b',
      name: 'write_file',
      input: { path: '../escape', content: 'bad' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    assert.equal(bad.isError, true);
    assert.equal(fs.existsSync(path.join(dir, '..', 'escape')), false);
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('executor caps command output', async () => {
  const dir = temp();
  const executor = new ProcessExecutor();
  try {
    fs.writeFileSync(path.join(dir, 'many.txt'), 'a'.repeat(1000));
    const result = await executor.execute({
      requestId: 'cap',
      name: 'search',
      input: { pattern: 'a', glob: '*.txt' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 40,
    });
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.output) < 100);
    const read = await executor.execute({
      requestId: 'readcap',
      name: 'read_file',
      input: { path: 'many.txt' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 40,
    });
    assert.equal(read.truncated, true);
    assert.ok(Buffer.byteLength(read.output) < 100);
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('local skill installs and loads on demand', () => {
  const dir = temp();
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const skillDir = path.join(dir, 'sample');
  fs.mkdirSync(skillDir);
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: sample\ndescription: Sample workflow\n---\nDo the work.\n',
  );
  const info = installLocal(skillDir);
  assert.equal(info.name, 'sample');
  assert.equal(listSkills().length, 1);
  assert.match(loadSkill('sample'), /Do the work/);
  delete process.env.BRUIN_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});
test('agent persists request, approval and result before continuing', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  let count = 0;
  const gateway: ModelGateway = {
    async complete() {
      count++;
      return count === 1
        ? { text: '', calls: [{ id: 'call-1', name: 'read_file', input: { path: 'a.txt' } }] }
        : { text: 'done', calls: [] };
    },
  };
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const executor: ToolExecutor = {
    async execute(): Promise<ToolResult> {
      return { output: 'hello', isError: false };
    },
    async close() {},
  };
  const runner = new AgentRunner(store, gateway, executor, {
    text() {},
    notice() {},
    async approve() {
      return false;
    },
  });
  await runner.run(session, 'read it');
  assert.deepEqual(
    store.events(session.id).map((e) => e.type),
    [
      'user',
      'assistant',
      'tool_requested',
      'tool_approved',
      'tool_started',
      'tool_finished',
      'assistant',
      'turn_completed',
    ],
  );
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
