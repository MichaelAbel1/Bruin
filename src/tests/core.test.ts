import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { SqliteEventStore } from '../storage/event-store.js';
import Database from 'better-sqlite3';
import { budgetPrompt, buildPrompt, promptBytes } from '../core/history.js';
import { isAutoSafeShell } from '../core/approval-policy.js';

import { decisionFor } from '../core/permissions.js';
import { AgentRunner, formatModelError } from '../core/agent.js';
import { RuntimeServices } from '../runtime/services.js';
import type { ModelGateway } from '../providers/gateway.js';
import type { ToolExecutor } from '../executor/client.js';
import type {
  ModelProfile,
  SessionEvent,
  ToolCall,
  ToolRequest,
  ToolResult,
} from '../core/types.js';
import { ProcessExecutor } from '../executor/client.js';
import { installLocal, listSkills, loadSkill } from '../skills/registry.js';
import {
  configLockPath,
  configPath,
  getRuntimeApiKey,
  loadConfig,
  saveConfig,
  setRuntimeApiKey,
  updateConfig,
  withConfigLock,
} from '../config.js';
import { loadInstructions } from '../core/instructions.js';
import {
  listWorkspaceEntries,
  readWorkspaceFile,
  writeWorkspaceFile,
} from '../core/workspace-files.js';
import { importAttachments } from '../core/attachments.js';

test('automatic Shell approval rejects command composition and mutation', () => {
  assert.equal(isAutoSafeShell('git status --short'), true);
  for (const command of [
    'git status --short; rm -rf .',
    'git status --short && curl example.com',
    'git diff --stat --ext-diff',
    'git reset --hard',
    'cat /etc/passwd',
  ])
    assert.equal(isAutoSafeShell(command), false, command);
});

test('history keeps more than ten turns when the configured budget allows it', () => {
  const events = Array.from({ length: 12 }, (_, index) => ({
    sessionId: 'history',
    seq: index + 1,
    type: 'user' as const,
    at: '2026-01-01T00:00:00.000Z',
    payload: { text: `turn ${index + 1}` },
  }));
  const prompt = buildPrompt(events, 'system', undefined, undefined, 100_000);
  assert.ok(prompt.some((message) => message.role === 'user' && message.content === 'turn 1'));
  assert.ok(prompt.some((message) => message.role === 'user' && message.content === 'turn 12'));
});

test('history rebuild uses only the newest durable compaction checkpoint', () => {
  const event = (
    seq: number,
    type: SessionEvent['type'],
    payload: Record<string, unknown>,
  ): SessionEvent => ({ sessionId: 'checkpoint', seq, type, at: '', payload });
  const messages = buildPrompt(
    [
      event(1, 'user', { text: 'obsolete raw request' }),
      event(2, 'summary', { throughSeq: 1, text: 'older summary' }),
      event(3, 'user', { text: 'another raw request' }),
      event(4, 'summary', { throughSeq: 3, text: 'latest retained summary' }),
      event(5, 'user', { text: 'current request' }),
    ],
    'system',
  );
  const serialized = JSON.stringify(messages);
  assert.match(serialized, /latest retained summary/);
  assert.match(serialized, /current request/);
  assert.doesNotMatch(serialized, /older summary|obsolete raw request|another raw request/);
});
const profile: ModelProfile = {
  alias: 'mock',
  provider: 'openai-compatible',
  model: 'mock',
  baseUrl: 'http://localhost:9999/v1',
};
const testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-core-home-'));
const globalOldHome = process.env.BRUIN_HOME;
process.env.BRUIN_HOME = testHomeDir;
after(() => {
  if (globalOldHome === undefined) delete process.env.BRUIN_HOME;
  else process.env.BRUIN_HOME = globalOldHome;
  fs.rmSync(testHomeDir, { recursive: true, force: true });
});

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-test-'));
}
test('global and project instructions load without following symlinks', () => {
  const dir = temp();
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  try {
    fs.mkdirSync(process.env.BRUIN_HOME);
    fs.writeFileSync(path.join(process.env.BRUIN_HOME, 'AGENTS.md'), 'Global rule');
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Project rule');
    const instructions = loadInstructions(workspace);
    assert.match(instructions, /Global rule/);
    assert.match(instructions, /Project rule/);
    fs.unlinkSync(path.join(workspace, 'AGENTS.md'));
    fs.symlinkSync(
      path.join(process.env.BRUIN_HOME, 'AGENTS.md'),
      path.join(workspace, 'AGENTS.md'),
    );
    assert.throws(() => loadInstructions(workspace));
  } finally {
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('user preferences are durable, exact quotes and removable', () => {
  const dir = temp();
  const filename = path.join(dir, 'db.sqlite');
  let store = new SqliteEventStore(filename);
  const session = store.createSession(dir, profile);
  store.append(session.id, 'user', { text: '以后请用中文回答。' });
  const preference = store.savePreference(session.id, '以后请用中文回答');
  assert.throws(() => store.savePreference(session.id, '推测的偏好'));
  store.close();
  store = new SqliteEventStore(filename);
  assert.equal(store.listPreferences()[0].content, '以后请用中文回答');
  store.deletePreference(preference.id);
  assert.equal(store.listPreferences().length, 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('agent automatically captures explicit preference and loads it on next turn', async () => {
  const dir = temp();
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  const prompts: string[] = [];
  const gateway: ModelGateway = {
    async complete(_profile, messages) {
      prompts.push(JSON.stringify(messages));
      return { text: 'OK', calls: [] };
    },
  };
  const executor = {
    async execute(): Promise<ToolResult> {
      throw new Error('unexpected');
    },
    async close() {},
  } as ToolExecutor;
  const runner = new AgentRunner(store, gateway, executor, {
    text() {},
    notice() {},
    async approve() {
      return false;
    },
  });
  try {
    await runner.run(session, '以后请用中文回答。');
    assert.equal(store.listPreferences()[0].content, '以后请用中文回答');
    await runner.run(session, '继续');
    assert.match(prompts[1], /User preferences saved locally/);
  } finally {
    store.close();
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('workspace file browser bounds reads and refuses escapes', () => {
  const dir = temp();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), 'hello');
  fs.symlinkSync(os.homedir(), path.join(dir, 'outside'));
  assert.deepEqual(
    listWorkspaceEntries(dir).map((entry) => entry.name),
    ['src'],
  );
  assert.equal(readWorkspaceFile(dir, 'src/main.ts').content, 'hello');
  assert.throws(() => readWorkspaceFile(dir, '../outside'));
  assert.throws(() => listWorkspaceEntries(dir, 'outside'));
  fs.rmSync(dir, { recursive: true, force: true });
});
test('writeWorkspaceFile atomically saves files within workspace and rejects escapes', () => {
  const dir = temp();
  try {
    writeWorkspaceFile(dir, 'src/app/index.ts', 'console.log("hello");');
    assert.equal(
      fs.readFileSync(path.join(dir, 'src/app/index.ts'), 'utf8'),
      'console.log("hello");',
    );

    writeWorkspaceFile(dir, 'src/app/index.ts', 'console.log("updated");');
    assert.equal(
      fs.readFileSync(path.join(dir, 'src/app/index.ts'), 'utf8'),
      'console.log("updated");',
    );

    assert.throws(() => writeWorkspaceFile(dir, '../secret.txt', 'evil'));
    assert.throws(() => writeWorkspaceFile(dir, '/etc/passwd', 'evil'));

    fs.symlinkSync(os.tmpdir(), path.join(dir, 'escaped_dir'));
    assert.throws(() => writeWorkspaceFile(dir, 'escaped_dir/leak.txt', 'fail'));

    // Cannot overwrite an existing directory
    fs.mkdirSync(path.join(dir, 'src/target_dir'));
    assert.throws(() => writeWorkspaceFile(dir, 'src/target_dir', 'fail'), /目标路径是一个目录/);

    // Cannot overwrite or follow an existing symlink target
    const external = path.join(dir, 'external.txt');
    fs.writeFileSync(external, 'safe external');
    const symlinkTarget = path.join(dir, 'src/link_target.ts');
    fs.symlinkSync(external, symlinkTarget);
    assert.throws(
      () => writeWorkspaceFile(dir, 'src/link_target.ts', 'evil content'),
      /不允许.*符号链接/,
    );
    assert.equal(fs.readFileSync(external, 'utf8'), 'safe external');

    // Verify no temporary files remain
    const tmpFiles = fs.readdirSync(path.join(dir, 'src')).filter((f) => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('readWorkspaceFile retrieves git baseline and tracks modification', () => {
  const dir = temp();
  try {
    execSync(
      'git init && git config user.name "test" && git config user.email "test@example.com"',
      {
        cwd: dir,
        stdio: 'ignore',
      },
    );
    fs.writeFileSync(path.join(dir, 'sample.txt'), 'line 1\nline 2\n');
    execSync('git add sample.txt && git commit -m "initial"', { cwd: dir, stdio: 'ignore' });

    fs.writeFileSync(path.join(dir, 'sample.txt'), 'line 1\nline 2 modified\nline 3\n');
    const read = readWorkspaceFile(dir, 'sample.txt');
    assert.equal(read.content, 'line 1\nline 2 modified\nline 3\n');
    assert.equal(read.baselineContent, 'line 1\nline 2\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
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
test('session leases prevent a second process from running or deleting the same session', () => {
  const dir = temp();
  const filename = path.join(dir, 'db.sqlite');
  const first = new SqliteEventStore(filename);
  const second = new SqliteEventStore(filename);
  try {
    const session = first.createSession(dir, profile);
    first.acquireLease(session.id, 'first', 30_000);
    assert.throws(() => second.acquireLease(session.id, 'second', 30_000), /另一个进程/);
    assert.throws(() => second.deleteSession(session.id), /运行中/);
    assert.equal(first.renewLease(session.id, 'first', 30_000), true);
    first.releaseLease(session.id, 'first');
    second.acquireLease(session.id, 'second', 30_000);
    second.releaseLease(session.id, 'second');
    second.deleteSession(session.id);
    assert.equal(first.getSession(session.id), undefined);
  } finally {
    first.close();
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('task graph claims are atomic across stores and depend on completed parents', () => {
  const dir = temp();
  const filename = path.join(dir, 'db.sqlite');
  const first = new SqliteEventStore(filename);
  const second = new SqliteEventStore(filename);
  try {
    const session = first.createSession(dir, profile);
    const parent = first.createTask(session.id, 'Investigate', []);
    const child = first.createTask(session.id, 'Implement', [parent.id]);
    assert.throws(
      () => first.updateTask(session.id, parent.id, { addBlockedBy: [child.id] }),
      /形成环/,
    );
    assert.equal(
      first.updateTask(session.id, child.id, { description: 'Implementation details' }).description,
      'Implementation details',
    );
    const parentFile = JSON.parse(
      fs.readFileSync(path.join(dir, '.tasks', `${parent.id}.json`), 'utf8'),
    );
    assert.deepEqual(parentFile.blocks, [child.id]);
    assert.deepEqual(parentFile.blockedBy, []);
    assert.throws(() => first.createTask(session.id, 'Bad', ['missing']), /依赖任务不存在/);
    assert.equal(second.claimTask(session.id, 'second', 5000)?.id, parent.id);
    assert.equal(first.claimTask(session.id, 'first', 5000), undefined);
    assert.throws(() => first.finishTask(parent.id, 'first', true), /租约/);
    second.finishTask(parent.id, 'second', true);
    assert.equal(first.claimTask(session.id, 'first', 5000)?.id, child.id);
    first.finishTask(child.id, 'first', true);
    assert.deepEqual(
      second.listTasks(session.id).map((task) => task.status),
      ['completed', 'completed'],
    );
  } finally {
    first.close();
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('workspace task files survive sessions and expose full task details', () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const first = store.createSession(dir, profile);
    const second = store.createSession(dir, profile);
    const task = store.createTask(first.id, 'Schema', [], 'Create database tables');
    assert.equal(store.getTask(second.id, task.id)?.description, 'Create database tables');
    assert.equal(store.claimTask(second.id, 'second', 5000)?.id, task.id);
    store.finishTask(task.id, 'second', true);
    store.deleteSession(first.id);
    assert.equal(store.listTasks(second.id)[0].status, 'completed');
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(dir, '.tasks', `${task.id}.json`), 'utf8'),
    );
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.description, 'Create database tables');
    fs.unlinkSync(path.join(dir, '.tasks', `${task.id}.json`));
    store.listTasks(second.id);
    assert.equal(fs.existsSync(path.join(dir, '.tasks', `${task.id}.json`)), false);
    store.syncTasks(second.id);
    assert.equal(fs.existsSync(path.join(dir, '.tasks', `${task.id}.json`)), true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('task snapshots reject a symlinked .tasks directory', () => {
  const dir = temp();
  const outside = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, profile);
    fs.symlinkSync(outside, path.join(dir, '.tasks'));
    assert.throws(() => store.createTask(session.id, 'Blocked', []), /真实目录/);
    assert.deepEqual(store.listTasks(session.id), []);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
test('version 5 task nodes migrate to workspace tasks without deleting task data', () => {
  const dir = temp();
  const filename = path.join(dir, 'db.sqlite');
  const raw = new Database(filename);
  try {
    raw.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, profile_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_nodes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, dependencies_json TEXT NOT NULL, status TEXT NOT NULL, owner TEXT, expires_at INTEGER, created_at TEXT NOT NULL);
      PRAGMA user_version = 5;`);
    raw
      .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
      .run('session', dir, JSON.stringify(profile), '2026-01-01', '2026-01-01');
    raw
      .prepare('INSERT INTO task_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy', 'session', 'Old task', '[]', 'pending', null, null, '2026-01-01');
  } finally {
    raw.close();
  }
  const store = new SqliteEventStore(filename);
  try {
    assert.equal(store.listTasks('session')[0]?.title, 'Old task');
    store.syncTasks('session');
    assert.ok(fs.existsSync(path.join(dir, '.tasks', 'legacy.json')));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('workspace memory and cron schedule survive reopen', () => {
  const dir = temp();
  const filename = path.join(dir, 'db.sqlite');
  let store = new SqliteEventStore(filename);
  try {
    const session = store.createSession(dir, profile);
    store.saveMemory(dir, 'conventions', 'Use npm test');
    const job = store.createCronJob(session.id, '* * * * *', 'Check status');
    store.close();
    store = new SqliteEventStore(filename);
    assert.equal(store.listMemory(dir)[0]?.content, 'Use npm test');
    assert.equal(store.listCronJobs(session.id)[0]?.id, job.id);
    assert.equal(store.takeDueCronJobs(job.nextRunAt)[0]?.id, job.id);
    assert.equal(store.takeDueCronJobs(job.nextRunAt).length, 0);
    assert.ok(store.listCronJobs(session.id)[0].nextRunAt > job.nextRunAt);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('expired task requires explicit retry before another process can claim it', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, profile);
    const task = store.createTask(session.id, 'Potentially side effecting', []);
    assert.equal(store.claimTask(session.id, 'first', 1000)?.id, task.id);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(store.claimTask(session.id, 'second', 1000), undefined);
    assert.equal(store.listTasks(session.id)[0].status, 'unknown');
    store.retryTask(session.id, task.id);
    assert.equal(store.claimTask(session.id, 'second', 1000)?.id, task.id);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('releasing an expired task does not make it automatically runnable', (t) => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, profile);
    const task = store.createTask(session.id, 'Potentially side effecting', []);
    const now = Date.now();
    const clock = t.mock.method(Date, 'now', () => now);
    assert.equal(store.claimTask(session.id, 'first', 1000)?.id, task.id);
    clock.mock.mockImplementation(() => now + 1100);
    store.releaseTask(task.id, 'first');
    assert.equal(store.getTask(session.id, task.id)?.status, 'unknown');
    assert.equal(store.claimTask(session.id, 'second', 1000), undefined);
    store.retryTask(session.id, task.id);
    assert.equal(store.claimTask(session.id, 'second', 1000)?.id, task.id);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('legacy key values are redacted from persisted session events', () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const secret = 'sk-test-legacy-exposed-value';
    const session = store.createSession(dir, { ...profile, apiKeyEnv: secret });
    store.append(session.id, 'model_error', { message: `Provider rejected ${secret}` });
    assert.equal(store.scrubSecrets([secret]), 2);
    assert.doesNotMatch(JSON.stringify(store.getSession(session.id)), /sk-test-legacy/);
    assert.doesNotMatch(JSON.stringify(store.events(session.id)), /sk-test-legacy/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('history reconstructs messages when provider protocol changes', () => {
  const events = [
    {
      sessionId: 's',
      seq: 1,
      type: 'assistant' as const,
      at: '',
      payload: {
        text: 'Earlier answer',
        profileAlias: 'remote',
        protocol: 'openai-responses',
        providerMessages: [{ role: 'assistant', content: 'raw Responses message' }],
      },
    },
  ];
  assert.deepEqual(buildPrompt(events, 'system', 'remote', 'openai-chat').at(-1), {
    role: 'assistant',
    content: 'Earlier answer',
  });
  assert.deepEqual(buildPrompt(events, 'system', 'remote', 'openai-responses').at(-1), {
    role: 'assistant',
    content: 'raw Responses message',
  });
});
test('history bounds older turns and oversized tool output', () => {
  const events = [] as Array<ReturnType<SqliteEventStore['append']>>;
  for (let i = 0; i < 10; i++) {
    events.push({
      sessionId: 's',
      seq: i * 2 + 1,
      type: 'user',
      at: '',
      payload: { text: `turn ${i}` },
    });
    events.push({
      sessionId: 's',
      seq: i * 2 + 2,
      type: 'assistant',
      at: '',
      payload: { text: 'x'.repeat(20000) },
    });
  }
  events.push({
    sessionId: 's',
    seq: 21,
    type: 'tool_finished',
    at: '',
    payload: { callId: 'call', name: 'shell', output: 'z'.repeat(50000) },
  });
  const prompt = buildPrompt(events, 'system');
  assert.ok(JSON.stringify(prompt).length < 130000);
  assert.match(JSON.stringify(prompt), /Earlier conversation summary/);
  assert.ok(JSON.stringify(prompt).includes('z'.repeat(1000)));
  assert.ok(!JSON.stringify(prompt).includes('z'.repeat(13000)));
});
test('model error includes structured API detail without dumping arbitrary body', () => {
  assert.equal(
    formatModelError({
      statusCode: 400,
      message: 'Bad Request',
      responseBody: JSON.stringify({ error: { message: 'This model does not support tools' } }),
    }),
    'HTTP 400: This model does not support tools',
  );
  assert.equal(
    formatModelError({
      statusCode: 422,
      message: 'Unprocessable Entity',
      responseBody: { error: { message: 'Invalid parameter value' } },
    }),
    'HTTP 422: Invalid parameter value',
  );
  assert.equal(
    formatModelError({ statusCode: 400, message: 'Bad Request', responseBody: '<private prompt>' }),
    'HTTP 400: Bad Request',
  );
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
test('recovery tracks reused tool call IDs by occurrence', () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, profile);
    const call = { id: 'reused', name: 'write_file' as const, input: { path: 'x', content: 'a' } };
    store.append(session.id, 'assistant', { text: '', calls: [call] });
    store.append(session.id, 'tool_finished', {
      callId: 'reused',
      name: 'write_file',
      output: 'done',
    });
    store.append(session.id, 'assistant', { text: '', calls: [call] });
    const runner = new AgentRunner(
      store,
      {
        async complete() {
          throw new Error('unexpected');
        },
      },
      {
        async execute() {
          throw new Error('unexpected');
        },
        async close() {},
      },
      {
        text() {},
        notice() {},
        async approve() {
          return false;
        },
      },
    );
    assert.equal(runner.recover(session), 1);
    assert.equal(runner.recover(session), 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
test('executor rejects a duplicate in-flight request ID without losing the first result', async () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const executor = new ProcessExecutor();
  const request: ToolRequest = {
    requestId: 'same',
    name: 'read_file',
    input: { path: 'a.txt' },
    workspace: dir,
    timeoutMs: 5000,
    maxOutputBytes: 100,
  };
  try {
    const first = executor.execute(request);
    await assert.rejects(executor.execute(request), /请求 ID/);
    assert.equal((await first).output, 'hello');
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('file tools replace content without losing permissions or changing files on failed edits', async () => {
  const dir = temp();
  const file = path.join(dir, 'script.sh');
  fs.writeFileSync(file, 'old text\n');
  fs.chmodSync(file, 0o755);
  const executor = new ProcessExecutor();
  try {
    const request = (
      id: string,
      name: 'write_file' | 'edit_file',
      input: Record<string, unknown>,
    ) =>
      executor.execute({
        requestId: id,
        name,
        input: { path: 'script.sh', ...input },
        workspace: dir,
        timeoutMs: 5000,
        maxOutputBytes: 100,
      });
    const write = await request('write', 'write_file', { content: 'updated text\n' });
    assert.equal(write.isError, false, write.output);
    assert.equal(write.output, '已写入 script.sh');
    assert.equal(fs.readFileSync(file, 'utf8'), 'updated text\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    assert.equal(
      (await request('bad-edit', 'edit_file', { oldText: 'missing', newText: 'x' })).isError,
      true,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'updated text\n');
    const edit = await request('edit', 'edit_file', { oldText: 'updated', newText: 'final' });
    assert.equal(edit.isError, false, edit.output);
    assert.equal(edit.output, '已编辑 script.sh');
    assert.equal(fs.readFileSync(file, 'utf8'), 'final text\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(dir), ['script.sh']);
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('edit_file refuses invalid UTF-8 without changing the original bytes', async () => {
  const dir = temp();
  const original = Buffer.from([0x6f, 0x6c, 0x64, 0xff, 0x74, 0x65, 0x78, 0x74]);
  const file = path.join(dir, 'mixed.txt');
  fs.writeFileSync(file, original);
  const executor = new ProcessExecutor();
  try {
    const result = await executor.execute({
      requestId: 'invalid-utf8-edit',
      name: 'edit_file',
      input: { path: 'mixed.txt', oldText: 'old', newText: 'new' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    assert.equal(result.isError, true);
    assert.match(result.output, /UTF-8/);
    assert.deepEqual(fs.readFileSync(file), original);
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
test('search treats no matches as a successful empty result', async () => {
  const dir = temp();
  const executor = new ProcessExecutor();
  try {
    fs.writeFileSync(path.join(dir, 'sample.txt'), 'hello');
    const result = await executor.execute({
      requestId: 'search-miss',
      name: 'search',
      input: { pattern: 'absent-pattern' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    assert.equal(result.isError, false, result.output);
    assert.equal(result.output, '');
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test(
  'cancelled Docker shell force-removes its named container',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = temp();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const marker = path.join(dir, 'docker.log');
    const slowCleanup = path.join(dir, 'slow-cleanup');
    const docker = path.join(bin, 'docker');
    fs.writeFileSync(
      docker,
      '#!/bin/sh\n' +
        'if [ "$1" = "run" ]; then\n' +
        '  shift\n' +
        '  while [ "$1" != "--name" ]; do shift; done\n' +
        `  echo "run:$2" >> '${marker}'\n` +
        '  sleep 30\n' +
        'else\n' +
        `  echo "rm:$3" >> '${marker}'\n` +
        `  if [ -f '${slowCleanup}' ]; then sleep 3; echo "rm-done:$3" >> '${marker}'; fi\n` +
        'fi\n',
      { mode: 0o755 },
    );
    const previous = {
      path: process.env.PATH,
      backend: process.env.BRUIN_SHELL_BACKEND,
      image: process.env.BRUIN_DOCKER_IMAGE,
    };
    process.env.PATH = `${bin}${path.delimiter}${previous.path ?? ''}`;
    process.env.BRUIN_SHELL_BACKEND = 'docker';
    process.env.BRUIN_DOCKER_IMAGE = 'test-image';
    const executor = new ProcessExecutor();
    try {
      const controller = new AbortController();
      const result = executor.execute(
        {
          requestId: 'docker-cancel',
          name: 'shell',
          input: { command: 'sleep 30' },
          workspace: dir,
          timeoutMs: 5000,
          maxOutputBytes: 100,
        },
        controller.signal,
      );
      for (let i = 0; i < 300 && !fs.existsSync(marker); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(fs.existsSync(marker), true);
      controller.abort();
      assert.equal((await result).isError, true);
      const entries = fs.readFileSync(marker, 'utf8').trim().split('\n');
      const name = entries.find((entry) => entry.startsWith('run:'))?.slice(4);
      assert.ok(name?.startsWith('bruin-'));
      assert.ok(entries.includes(`rm:${name}`));
      const timedOut = await executor.execute({
        requestId: 'docker-timeout',
        name: 'shell',
        input: { command: 'sleep 30' },
        workspace: dir,
        timeoutMs: 500,
        maxOutputBytes: 100,
      });
      assert.equal(timedOut.isError, true);
      const afterTimeout = fs.readFileSync(marker, 'utf8').trim().split('\n');
      const timeoutName = afterTimeout
        .filter((entry) => entry.startsWith('run:'))
        .at(-1)
        ?.slice(4);
      assert.ok(timeoutName?.startsWith('bruin-'));
      assert.ok(afterTimeout.includes(`rm:${timeoutName}`));
      const pendingClose = executor
        .execute({
          requestId: 'docker-close',
          name: 'shell',
          input: { command: 'sleep 30' },
          workspace: dir,
          timeoutMs: 10_000,
          maxOutputBytes: 100,
        })
        .catch(() => undefined);
      for (let i = 0; i < 100; i++) {
        if (
          fs
            .readFileSync(marker, 'utf8')
            .split('\n')
            .filter((entry) => entry.startsWith('run:')).length === 3
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const closeName = fs
        .readFileSync(marker, 'utf8')
        .split('\n')
        .filter((entry) => entry.startsWith('run:'))
        .at(-1)
        ?.slice(4);
      assert.ok(closeName?.startsWith('bruin-'));
      fs.writeFileSync(slowCleanup, 'yes');
      await executor.close();
      await pendingClose;
      assert.match(fs.readFileSync(marker, 'utf8'), new RegExp(`rm-done:${closeName}`));
    } finally {
      await executor.close();
      for (const [key, value] of Object.entries({
        PATH: previous.path,
        BRUIN_SHELL_BACKEND: previous.backend,
        BRUIN_DOCKER_IMAGE: previous.image,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('ProcessExecutor executes shell commands out of the box without docker', async () => {
  const dir = temp();
  const executor = new ProcessExecutor();
  try {
    const res = await executor.execute({
      requestId: 'shell-test-1',
      name: 'shell',
      input: { command: process.platform === 'win32' ? 'echo hello_world' : 'echo "hello_world"' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    assert.equal(res.isError, false);
    assert.match(res.output, /hello_world/);
    if (process.platform === 'win32' && process.env.BRUIN_SHELL_BACKEND !== 'docker') {
      const unattended = await executor.execute({
        requestId: 'shell-hook-test',
        name: 'shell',
        input: { command: 'echo should_not_run' },
        workspace: dir,
        timeoutMs: 5000,
        maxOutputBytes: 1000,
        requireSandbox: true,
      });
      assert.equal(unattended.isError, true);
      assert.match(unattended.output, /Hook/);
    }
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'Windows shell cancellation stops child processes',
  { skip: process.platform !== 'win32' || process.env.BRUIN_SHELL_BACKEND === 'docker' },
  async () => {
    const dir = temp();
    const ready = path.join(dir, 'ready.txt');
    const escaped = path.join(dir, 'escaped.txt');
    const script = path.join(dir, 'child.cjs');
    fs.writeFileSync(
      script,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => fs.writeFileSync(${JSON.stringify(escaped)}, 'escaped'), 1200);`,
    );
    const executor = new ProcessExecutor();
    const controller = new AbortController();
    try {
      const pending = executor.execute(
        {
          requestId: 'windows-tree-cancel',
          name: 'shell',
          input: { command: `"${process.execPath}" "${script}"` },
          workspace: dir,
          timeoutMs: 5000,
          maxOutputBytes: 1000,
        },
        controller.signal,
      );
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(ready) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(ready), true, 'nested process did not start');
      controller.abort();
      assert.equal((await pending).isError, true);
      await new Promise((resolve) => setTimeout(resolve, 1400));
      assert.equal(fs.existsSync(escaped), false, 'nested process survived cancellation');
    } finally {
      controller.abort();
      await executor.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('local skill installs and loads on demand', () => {
  const dir = temp();
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  try {
    const skillDir = path.join(dir, 'sample');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: sample\ndescription: Sample workflow\n---\nDo the work.\n',
    );
    const info = installLocal(skillDir);
    assert.equal(info.name, 'sample');
    assert.ok(listSkills().some((skill) => skill.name === 'sample'));
    assert.match(loadSkill('sample'), /Do the work/);
  } finally {
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
test('agent rejects malformed tool input before approval or execution', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  let calls = 0;
  let approvals = 0;
  const gateway: ModelGateway = {
    async complete() {
      calls++;
      return calls === 1
        ? { text: '', calls: [{ id: 'bad', name: 'write_file', input: { path: 5, content: 'x' } }] }
        : { text: 'done', calls: [] };
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      throw new Error('must not execute');
    },
    async close() {},
  };
  try {
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      async approve() {
        approvals++;
        return true;
      },
    });
    await runner.run(session, 'write it');
    assert.equal(approvals, 0);
    assert.ok(store.events(session.id).some((event) => event.type === 'tool_denied'));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('agent rejects duplicate tool call IDs before any side effect', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, profile);
    const runner = new AgentRunner(
      store,
      {
        async complete() {
          return {
            text: '',
            calls: [
              { id: 'same', name: 'write_file', input: { path: 'a', content: 'first' } },
              { id: 'same', name: 'write_file', input: { path: 'b', content: 'second' } },
            ],
          };
        },
      },
      {
        async execute() {
          throw new Error('must not execute');
        },
        async close() {},
      },
      {
        text() {},
        notice() {},
        async approve() {
          throw new Error('must not approve');
        },
      },
    );
    await assert.rejects(runner.run(session, 'write both'), /重复的工具调用 ID/);
    assert.deepEqual(
      store.events(session.id).map((event) => event.type),
      ['user', 'model_error'],
    );
    assert.equal(fs.existsSync(path.join(dir, 'a')), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('model errors redact the active API key before persistence and display', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  const secret = 'test-only-provider-secret';
  setRuntimeApiKey(profile.alias, secret);
  const gateway: ModelGateway = {
    async complete() {
      throw new Error(`provider rejected ${secret}`);
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      throw new Error('unused');
    },
    async close() {},
  };
  try {
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      async approve() {
        return false;
      },
    });
    await assert.rejects(runner.run(session, 'hello'), (error) => {
      assert.doesNotMatch(String(error), /test-only-provider-secret/);
      return true;
    });
    assert.doesNotMatch(JSON.stringify(store.events(session.id)), /test-only-provider-secret/);
  } finally {
    setRuntimeApiKey(profile.alias, undefined);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('cancelling a model retry stops before another request', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  const controller = new AbortController();
  let attempts = 0;
  const gateway: ModelGateway = {
    async complete() {
      attempts++;
      throw Object.assign(new Error('temporarily unavailable'), { statusCode: 503 });
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      throw new Error('unexpected');
    },
    async close() {},
  };
  try {
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {
        controller.abort();
      },
      async approve() {
        return false;
      },
    });
    await assert.rejects(runner.run(session, 'hello', controller.signal), /已取消/);
    assert.equal(attempts, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('buildPrompt heals dangling tool calls and preserves tool actions in summary', () => {
  const events: SessionEvent[] = [
    {
      sessionId: 's',
      seq: 1,
      type: 'user',
      at: '',
      payload: { text: 'read it' },
    },
    {
      sessionId: 's',
      seq: 2,
      type: 'assistant',
      at: '',
      payload: {
        text: 'calling two tools',
        calls: [
          { id: 'c1', name: 'read_file', input: { path: 'a.txt' } },
          { id: 'c2', name: 'read_file', input: { path: 'b.txt' } },
        ],
      },
    },
    {
      sessionId: 's',
      seq: 3,
      type: 'tool_finished',
      at: '',
      payload: { callId: 'c1', name: 'read_file', output: 'content of a' },
    },
    // Note: c2 is dangling (interrupted or process died before it finished)
  ];
  const prompt = buildPrompt(events, 'system instructions');
  // Both c1 and c2 should have tool results so the LLM API never rejects with 400
  const toolResults = prompt.filter((m) => m.role === 'tool');
  assert.equal(toolResults.length, 2);
  assert.match(JSON.stringify(toolResults[0]), /content of a/);
  assert.match(JSON.stringify(toolResults[1]), /ERROR: Action interrupted/);

  // Test providerMessages path also registers pending tool calls and heals dangling ones
  const providerEvents: SessionEvent[] = [
    {
      sessionId: 's',
      seq: 1,
      type: 'user',
      at: '',
      payload: { text: 'run tools' },
    },
    {
      sessionId: 's',
      seq: 2,
      type: 'assistant',
      at: '',
      payload: {
        profileAlias: 'mock',
        protocol: 'mock-protocol',
        providerMessages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'using tools' },
              {
                type: 'tool-call',
                toolCallId: 'pm-1',
                toolName: 'read_file',
                input: { path: 'a.txt' },
              },
            ],
          },
        ],
        calls: [{ id: 'pm-1', name: 'read_file', input: { path: 'a.txt' } }],
      },
    },
    // pm-1 dangling (no tool result event follows)
  ];
  const pmPrompt = buildPrompt(providerEvents, 'sys', 'mock', 'mock-protocol');
  const pmToolResults = pmPrompt.filter((m) => m.role === 'tool');
  assert.equal(pmToolResults.length, 1);
  assert.match(JSON.stringify(pmToolResults[0]), /ERROR: Action interrupted/);
});
test('buildPrompt keeps the newest complete turns within its history budget', () => {
  const events: SessionEvent[] = Array.from({ length: 12 }, (_, index) => ({
    sessionId: 'budget',
    seq: index + 1,
    type: 'user' as const,
    at: '',
    payload: { text: `${index}:` + 'x'.repeat(15_000) },
  }));
  const prompt = buildPrompt(events, 'system');
  const users = prompt.filter((message) => message.role === 'user');
  assert.equal(users.length, 7); // summary plus the newest six turns
  assert.match(String(users[0].content), /Earlier conversation summary/);
  assert.match(String(users[1].content), /^6:/);
  assert.match(String(users.at(-1)?.content), /^11:/);
});
test('budgetPrompt compresses old and oversized current input without aborting', () => {
  const messages = [
    { role: 'system' as const, content: 'instructions' },
    { role: 'user' as const, content: 'old:' + 'x'.repeat(15_000) },
    { role: 'assistant' as const, content: 'old reply' },
    { role: 'user' as const, content: 'new:' + 'y'.repeat(15_000) },
  ];
  const budgeted = budgetPrompt(messages, 32_768);
  assert.equal(budgeted.length, 3);
  assert.match(String(budgeted[1].content), /Earlier conversation summary/);
  assert.equal(budgeted[2], messages[3]);
  assert.equal(messages.length, 4);
  assert.equal(budgetPrompt(messages, 65_536).length, 4);
  assert.throws(
    () => budgetPrompt([{ role: 'system', content: 'x'.repeat(30_000) }], 32_768),
    /上下文预算不足/,
  );
  const huge = budgetPrompt(
    [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'begin:' + 'z'.repeat(100_000) + ':end' },
    ],
    8192,
  );
  assert.ok(promptBytes(huge) <= 6144);
  assert.match(JSON.stringify(huge), /begin:/);
  assert.match(JSON.stringify(huge), /:end/);
  const imagePrompt = budgetPrompt([
    { role: 'system', content: 'instructions' },
    {
      role: 'user',
      content: [
        {
          type: 'image',
          image: new URL(`data:image/png;base64,${'a'.repeat(30_000)}`),
          mediaType: 'image/png',
        },
      ],
    },
  ]);
  assert.equal(imagePrompt.length, 2);
});

test('agent persists a model summary and reuses it after context compaction', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, { ...profile, contextWindowTokens: 8192 });
    for (let index = 0; index < 4; index++) {
      store.append(session.id, 'user', { text: `request ${index}: ${'detail '.repeat(300)}` });
      store.append(session.id, 'assistant', { text: `result ${index}: ${'finding '.repeat(300)}` });
    }
    let summaries = 0;
    let delivered = '';
    const gateway: ModelGateway = {
      async summarize() {
        summaries++;
        return 'User goal: inspect the project. Decision: retain existing behavior. Tests pending.';
      },
      async complete(_profile, prompt) {
        delivered = JSON.stringify(prompt);
        return { text: 'continued', calls: [] };
      },
    };
    const executor: ToolExecutor = {
      async execute() {
        throw new Error('unexpected tool');
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
    await runner.run(session, 'continue the analysis');
    assert.ok(summaries > 0);
    const checkpoint = store
      .events(session.id)
      .find((event) => event.type === 'summary' && event.payload.throughSeq);
    assert.ok(checkpoint);
    assert.match(String(checkpoint.payload.text), /retain existing behavior/);
    assert.match(delivered, /retain existing behavior/);
    assert.match(delivered, /continue the analysis/);
    assert.equal(store.events(session.id).filter((event) => event.type === 'user').length, 5);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent summarizes an oversized current request and completes the turn', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, { ...profile, contextWindowTokens: 8192 });
    let summaries = 0;
    let delivered = '';
    const gateway: ModelGateway = {
      async summarize() {
        summaries++;
        return 'Current request: inspect files and report findings; keep all user constraints.';
      },
      async complete(_profile, prompt) {
        delivered = JSON.stringify(prompt);
        return { text: 'done', calls: [] };
      },
    };
    const executor: ToolExecutor = {
      async execute() {
        throw new Error('unexpected tool');
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
    await runner.run(session, `inspect files ${'specific requirement '.repeat(6000)}finish`);
    assert.ok(summaries > 0);
    assert.match(delivered, /keep all user constraints/);
    assert.ok(
      store
        .events(session.id)
        .some((event) => event.type === 'summary' && event.payload.throughSeq),
    );
    assert.equal(store.events(session.id).at(-1)?.type, 'turn_completed');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent retries a provider context-limit error with a smaller prompt', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, { ...profile, contextWindowTokens: 32_768 });
    const sizes: number[] = [];
    const gateway: ModelGateway = {
      async complete(_profile, prompt) {
        sizes.push(promptBytes(prompt));
        if (sizes.length === 1)
          throw Object.assign(new Error('maximum context length exceeded'), { statusCode: 400 });
        return { text: 'continued', calls: [] };
      },
    };
    const executor: ToolExecutor = {
      async execute() {
        throw new Error('unexpected tool');
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
    await runner.run(session, `Start ${'constraint '.repeat(1600)} End`);
    assert.equal(sizes.length, 2);
    assert.ok(sizes[1] < sizes[0]);
    assert.equal(store.events(session.id).at(-1)?.type, 'turn_completed');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('tasks can be deleted safely without removing unrelated files or breaking dependents', () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  try {
    const parent = store.createTask(session.id, 'Parent Task', [], 'Parent desc');
    const child = store.createTask(session.id, 'Child Task', [parent.id], 'Child desc');
    assert.equal(store.listTasks(session.id).length, 2);
    assert.ok(fs.existsSync(path.join(dir, '.tasks', `${parent.id}.json`)));

    // Trying to delete parent should fail because child depends on it
    assert.throws(() => store.deleteTask(session.id, parent.id), /无法删除被任务/);

    // Deleting child should succeed and remove its snapshot
    store.deleteTask(session.id, child.id);
    assert.equal(store.listTasks(session.id).length, 1);
    assert.ok(!fs.existsSync(path.join(dir, '.tasks', `${child.id}.json`)));

    // Files outside the SQLite task graph may belong to the user.
    const orphanFile = path.join(dir, '.tasks', 'orphan-task.json');
    fs.writeFileSync(orphanFile, '{}');
    assert.ok(fs.existsSync(orphanFile));
    store.syncTasks(session.id);
    assert.ok(fs.existsSync(orphanFile));

    // Now deleting parent should succeed
    store.deleteTask(session.id, parent.id);
    assert.equal(store.listTasks(session.id).length, 0);
    assert.ok(!fs.existsSync(path.join(dir, '.tasks', `${parent.id}.json`)));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('task deletion refuses a replaced .tasks directory before changing SQLite', () => {
  const dir = temp();
  const outside = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, profile);
    const task = store.createTask(session.id, 'Keep task', []);
    fs.renameSync(path.join(dir, '.tasks'), path.join(dir, 'saved-tasks'));
    const outsideFile = path.join(outside, `${task.id}.json`);
    fs.writeFileSync(outsideFile, 'user data');
    fs.symlinkSync(outside, path.join(dir, '.tasks'));
    assert.throws(() => store.deleteTask(session.id, task.id), /真实目录/);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'user data');
    assert.equal(store.getTask(session.id, task.id)?.id, task.id);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
test('step limit pauses with a side-effect report and resumes without replaying completed tools', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  let stepCalls = 0;
  let writes = 0;
  const gateway: ModelGateway = {
    async complete() {
      stepCalls++;
      return stepCalls <= 2
        ? {
            text: '',
            calls: [
              {
                id: 'reused-call',
                name: 'write_file',
                input: { path: `changed-${stepCalls}.txt`, content: `result ${stepCalls}` },
              },
            ],
          }
        : { text: 'All work verified.', calls: [] };
    },
  };
  const executor: ToolExecutor = {
    async execute(request) {
      writes++;
      fs.writeFileSync(path.join(dir, String(request.input.path)), String(request.input.content));
      return { output: 'written', isError: false };
    },
    async close() {},
  };
  process.env.BRUIN_MAX_STEPS = '2';
  try {
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      async approve() {
        return true;
      },
    });
    await runner.run(session, 'modify two files and verify');
    assert.equal(stepCalls, 2);
    const lastEvent = store.events(session.id).at(-1);
    assert.equal(lastEvent?.type, 'turn_paused');
    assert.match(String(lastEvent.payload.report), /changed-1\.txt/);
    assert.match(String(lastEvent.payload.report), /changed-2\.txt/);
    assert.equal(fs.readFileSync(path.join(dir, 'changed-1.txt'), 'utf8'), 'result 1');
    assert.equal(fs.readFileSync(path.join(dir, 'changed-2.txt'), 'utf8'), 'result 2');
    assert.equal(runner.recover(session), 0);
    await runner.run(session);
    assert.equal(stepCalls, 3);
    assert.equal(writes, 2);
    assert.equal(store.events(session.id).at(-1)?.type, 'turn_completed');
  } finally {
    delete process.env.BRUIN_MAX_STEPS;
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('long run continues past the normal 24-call limit and records a durable checkpoint', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  fs.writeFileSync(path.join(dir, 'source.txt'), 'source');
  let calls = 0;
  const checkpoints: number[] = [];
  const gateway: ModelGateway = {
    async complete() {
      calls++;
      return calls <= 25
        ? {
            text: '',
            calls: [{ id: `read-${calls}`, name: 'read_file', input: { path: 'source.txt' } }],
          }
        : { text: 'Verified.', calls: [] };
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      return { output: 'source', isError: false };
    },
    async close() {},
  };
  try {
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      checkpoint(modelCalls) {
        checkpoints.push(modelCalls);
      },
      async approve() {
        throw new Error('read_file must not need approval');
      },
    });
    await runner.run(session, 'inspect all files', undefined, [], undefined, {
      maxModelCalls: 30,
      checkpointEvery: 24,
    });
    assert.equal(calls, 26);
    assert.deepEqual(checkpoints, [24]);
    const events = store.events(session.id);
    assert.equal(events.filter((event) => event.type === 'turn_checkpoint').length, 1);
    assert.equal(events.find((event) => event.type === 'turn_checkpoint')?.payload.modelCalls, 24);
    assert.equal(events.at(-1)?.type, 'turn_completed');
    assert.equal(events.filter((event) => event.type === 'turn_paused').length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('long run time budget pauses after completed tools without replaying them', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  fs.writeFileSync(path.join(dir, 'source.txt'), 'source');
  let calls = 0;
  const gateway: ModelGateway = {
    async complete() {
      calls++;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          text: '',
          calls: [{ id: 'read-1', name: 'read_file', input: { path: 'source.txt' } }],
        };
      }
      return { text: 'Done.', calls: [] };
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      return { output: 'source', isError: false };
    },
    async close() {},
  };
  try {
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      async approve() {
        throw new Error('read_file must not need approval');
      },
    });
    await runner.run(session, 'inspect', undefined, [], undefined, {
      maxModelCalls: 30,
      maxDurationMs: 1,
    });
    assert.equal(calls, 1);
    assert.equal(store.events(session.id).at(-1)?.payload.reason, 'time_limit');
    await runner.run(session);
    assert.equal(calls, 2);
    assert.equal(store.events(session.id).at(-1)?.type, 'turn_completed');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resuming a paused turn does not rerun the turn-started hook', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  fs.writeFileSync(path.join(dir, 'source.txt'), 'source');
  let calls = 0;
  let started = 0;
  const gateway: ModelGateway = {
    async complete() {
      calls++;
      return calls === 1
        ? { text: '', calls: [{ id: 'read-1', name: 'read_file', input: { path: 'source.txt' } }] }
        : { text: 'Done.', calls: [] };
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      return { output: 'source', isError: false };
    },
    async close() {},
  };
  const services = new RuntimeServices(store, executor, async () => {});
  services.runHooks = async (event) => {
    if (event === 'turn_started') started++;
  };
  try {
    const runner = new AgentRunner(
      store,
      gateway,
      executor,
      {
        text() {},
        notice() {},
        async approve() {
          return true;
        },
      },
      services,
    );
    await runner.run(session, 'inspect', undefined, [], undefined, { maxModelCalls: 1 });
    assert.equal(store.events(session.id).at(-1)?.type, 'turn_paused');
    await runner.run(session);
    assert.equal(started, 1);
    assert.equal(store.events(session.id).at(-1)?.type, 'turn_completed');
  } finally {
    await services.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unattended run rejects unapproved tools without executing them or losing the turn', async () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  const session = store.createSession(dir, profile);
  let calls = 0;
  let approvals = 0;
  let executions = 0;
  const gateway: ModelGateway = {
    async complete() {
      calls++;
      return calls === 1
        ? { text: '', calls: [{ id: 'shell-1', name: 'shell', input: { command: 'npm install' } }] }
        : { text: 'Approval is required to install dependencies.', calls: [] };
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      executions++;
      return { output: 'unexpected', isError: false };
    },
    async close() {},
  };
  try {
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      async approve() {
        approvals++;
        return '无人值守模式：未预先授权';
      },
    });
    await assert.rejects(
      runner.run(session, 'install dependencies', undefined, [], undefined, { maxModelCalls: 480 }),
      /需要显式启用无人值守模式/,
    );
    assert.deepEqual(store.events(session.id), []);
    await runner.run(session, 'install dependencies', undefined, [], undefined, {
      maxModelCalls: 480,
      unattended: true,
    });
    assert.equal(calls, 2);
    assert.equal(approvals, 1);
    assert.equal(executions, 0);
    assert.match(
      String(
        store.events(session.id).find((event) => event.type === 'tool_denied')?.payload.output,
      ),
      /未预先授权/,
    );
    assert.equal(store.events(session.id).at(-1)?.type, 'turn_completed');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write_file automatically creates nested parent directories and permissions allow it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-write-test-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-write-outside-'));
  const executor = new ProcessExecutor();
  try {
    const call: ToolCall = {
      id: 'w1',
      name: 'write_file',
      input: { path: 'nested/sub/folder/hello.txt', content: 'world' },
    };
    const decision = decisionFor(call, dir);
    assert.equal(decision.decision, 'ask');

    const result = await executor.execute({
      requestId: 'req-1',
      name: 'write_file',
      input: call.input,
      workspace: dir,
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    assert.equal(result.isError, false);
    assert.equal(
      fs.readFileSync(path.join(dir, 'nested', 'sub', 'folder', 'hello.txt'), 'utf8'),
      'world',
    );
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    const escaped: ToolCall = {
      id: 'w2',
      name: 'write_file',
      input: { path: 'linked/sub/escape.txt', content: 'bad' },
    };
    assert.equal(decisionFor(escaped, dir).decision, 'deny');
    const denied = await executor.execute({
      requestId: 'req-2',
      name: 'write_file',
      input: escaped.input,
      workspace: dir,
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    assert.equal(denied.isError, true);
    assert.equal(fs.existsSync(path.join(outside, 'sub')), false);
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('deleteSession removes associated attachments directory from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-store-attach-'));
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const store = new SqliteEventStore(path.join(dir, 'bruin.db'));
  try {
    const session = store.createSession(dir, profile);
    const source = path.join(dir, 'sample.txt');
    fs.writeFileSync(source, 'attachment data');
    const [ref] = importAttachments(session.id, [source]);
    const attachDir = path.join(process.env.BRUIN_HOME, 'attachments', session.id);
    assert.equal(fs.existsSync(path.join(attachDir, ref.id)), true);
    const unrelatedDir = path.join(dir, 'attachments', session.id);
    fs.mkdirSync(unrelatedDir, { recursive: true });
    fs.writeFileSync(path.join(unrelatedDir, 'keep.txt'), 'unrelated');

    store.deleteSession(session.id);
    assert.equal(fs.existsSync(attachDir), false);
    assert.equal(fs.readFileSync(path.join(unrelatedDir, 'keep.txt'), 'utf8'), 'unrelated');
  } finally {
    store.close();
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed attachment batch removes files already copied in that batch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-attach-rollback-'));
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const first = path.join(dir, 'first.txt');
  const second = path.join(dir, 'second.txt');
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(second, 'second');
  const originalWrite = fs.writeFileSync;
  let writes = 0;
  try {
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === 'string' && args[0].includes(`${path.sep}attachments${path.sep}`)) {
        writes++;
        if (writes === 3) throw new Error('simulated disk failure');
      }
      return originalWrite(...args);
    }) as typeof fs.writeFileSync;
    assert.throws(
      () => importAttachments('00000000-0000-0000-0000-000000000000', [first, second]),
      /simulated disk failure/,
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(process.env.BRUIN_HOME, 'attachments', '00000000-0000-0000-0000-000000000000'),
      ),
      [],
    );
  } finally {
    fs.writeFileSync = originalWrite;
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('history does not read image bytes from an older turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-old-image-'));
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const sessionId = '00000000-0000-0000-0000-000000000001';
  try {
    const source = path.join(dir, 'picture.png');
    fs.writeFileSync(source, 'image bytes');
    const [ref] = importAttachments(sessionId, [source]);
    const events: SessionEvent[] = [
      { sessionId, seq: 1, type: 'user', at: '', payload: { text: '旧图片', attachments: [ref] } },
      { sessionId, seq: 2, type: 'user', at: '', payload: { text: '新问题' } },
    ];
    fs.unlinkSync(path.join(process.env.BRUIN_HOME, 'attachments', sessionId, ref.id));
    const prompt = buildPrompt(events, 'system');
    assert.match(JSON.stringify(prompt), /之前的图片内容未重复发送/);
    assert.doesNotMatch(JSON.stringify(prompt), /附件 picture.png 已不可读取/);
  } finally {
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tool execution runtime exception is recorded as tool_unknown and halts runner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-tool-unknown-'));
  const store = new SqliteEventStore(path.join(dir, 'bruin.db'));
  const session = store.createSession(dir, profile);
  const gateway: ModelGateway = {
    async complete(_profile, _prompt, _signal, _onDelta) {
      return {
        text: 'calling',
        calls: [{ id: 'c1', name: 'read_file', input: { path: 'file.txt' } }],
        providerMessages: [],
      };
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      throw new Error('connection reset / timeout during execution');
    },
    async close() {},
  };
  try {
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content');
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      async approve() {
        return true;
      },
    });
    await assert.rejects(runner.run(session, 'test'), /connection reset/);
    const lastEvent = store.events(session.id).at(-1);
    assert.equal(lastEvent?.type, 'tool_unknown');
    assert.match(String(lastEvent?.payload.output), /connection reset/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load_skill returns isError when skill does not exist without halting runner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-skill-fail-'));
  const store = new SqliteEventStore(path.join(dir, 'bruin.db'));
  const session = store.createSession(dir, profile);
  let step = 0;
  const gateway: ModelGateway = {
    async complete(_profile, _prompt, _signal, _onDelta) {
      step++;
      if (step === 1) {
        return {
          text: '',
          calls: [{ id: 's1', name: 'load_skill', input: { name: 'missing-skill' } }],
          providerMessages: [],
        };
      }
      return {
        text: 'Skill was not found, proceeding without it.',
        calls: [],
        providerMessages: [],
      };
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      return { output: '', isError: false };
    },
    async close() {},
  };
  try {
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      async approve() {
        return true;
      },
    });
    await runner.run(session, 'test');
    assert.equal(step, 2);
    const toolEvent = store
      .events(session.id)
      .find((e) => e.type === 'tool_finished' && e.payload.callId === 's1');
    assert.ok(toolEvent);
    assert.equal(toolEvent.payload.isError, true);
    assert.match(String(toolEvent.payload.output), /Skill 不存在/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('storage failure during load_skill is not masked as a skill error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-skill-store-fail-'));
  const store = new SqliteEventStore(path.join(dir, 'bruin.db'));
  const session = store.createSession(dir, profile);
  const gateway: ModelGateway = {
    async complete(_profile, _prompt, _signal, _onDelta) {
      return {
        text: '',
        calls: [{ id: 's1', name: 'load_skill', input: { name: 'code-review' } }],
        providerMessages: [],
      };
    },
  };
  const executor: ToolExecutor = {
    async execute() {
      return { output: '', isError: false };
    },
    async close() {},
  };
  const originalAppend = store.append.bind(store);
  store.append = (id, type, payload) => {
    if (type === 'skill_loaded') {
      throw new Error('disk full / SQLite I/O error');
    }
    return originalAppend(id, type, payload);
  };
  try {
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      async approve() {
        return true;
      },
    });
    await assert.rejects(runner.run(session, 'test'), /disk full/);
    const events = store.events(session.id);
    assert.equal(
      events.some((e) => e.type === 'tool_unknown'),
      true,
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteSession preserves workspace files on disk and removes session records', () => {
  const dir = fs.realpathSync(temp());
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const managedDir = path.join(dir, 'workspaces', '20260928-120000-11223344');
    const session = store.createManagedSession(managedDir, profile);
    store.materializeWorkspace(session.id);
    fs.writeFileSync(path.join(managedDir, 'user-code.ts'), 'console.log("user code");');
    assert.ok(fs.existsSync(managedDir));

    store.deleteSession(session.id);
    // User files and workspace must NOT be deleted
    assert.equal(fs.existsSync(managedDir), true);
    assert.equal(fs.existsSync(path.join(managedDir, 'user-code.ts')), true);
    assert.equal(store.getSession(session.id), undefined);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeDueCronJobs handles invalid cron expression gracefully without blocking other jobs', () => {
  const dir = temp();
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, profile);
    // Insert a job with a normal expression, and one with corrupted/invalid expression
    const validJob = store.createCronJob(session.id, '* * * * *', 'Valid job');
    // Corrupt expression directly in database to test recovery
    const badId = 'bad-job-id';
    (store as any).db
      .prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, NULL)')
      .run(badId, session.id, 'not-a-cron-expr', 'Broken job', validJob.nextRunAt - 100);

    // takeDueCronJobs should skip the bad job and return the valid job directly
    const due = store.takeDueCronJobs(validJob.nextRunAt);
    assert.equal(due.length, 1);
    assert.equal(due[0].id, validJob.id);

    // Bad job should now be marked invalid_expression and pushed into the future
    const badJobRow = (store as any).db
      .prepare('SELECT last_status, next_run_at FROM cron_jobs WHERE id = ?')
      .get(badId) as { last_status: string; next_run_at: number };
    assert.equal(badJobRow.last_status, 'invalid_expression');
    assert.ok(badJobRow.next_run_at > validJob.nextRunAt);

    // Next takeDueCronJobs should return empty
    const nextDue = store.takeDueCronJobs(validJob.nextRunAt);
    assert.equal(nextDue.length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file replaces literal dollar patterns without special regex substitution', async () => {
  const dir = temp();
  const file = path.join(dir, 'prices.js');
  fs.writeFileSync(file, 'const price = 0;\nconst ref = "orig";\n');
  const executor = new ProcessExecutor();
  try {
    const edit = await executor.execute({
      requestId: 'e1',
      name: 'edit_file',
      input: {
        path: 'prices.js',
        oldText: 'const price = 0;',
        newText: 'const price = "$100" + "$$" + "$&";',
      },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    assert.equal(edit.isError, false, edit.output);
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content, 'const price = "$100" + "$$" + "$&";\nconst ref = "orig";\n');
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file tools reject operating on workspace root directory as a file', async () => {
  const dir = temp();
  const executor = new ProcessExecutor();
  try {
    const read = await executor.execute({
      requestId: 'r0',
      name: 'read_file',
      input: { path: '.' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    assert.equal(read.isError, true);
    assert.match(read.output, /工作区根目录/);

    const write = await executor.execute({
      requestId: 'w0',
      name: 'write_file',
      input: { path: '.', content: 'test' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    assert.equal(write.isError, true);
    assert.match(write.output, /工作区根目录/);
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ProcessExecutor auto-respawns worker child if it unexpectedly terminates', async () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'test.txt'), 'content');
  const executor = new ProcessExecutor();
  try {
    const first = await executor.execute({
      requestId: 'f1',
      name: 'read_file',
      input: { path: 'test.txt' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    assert.equal(first.output, 'content');

    // Forcibly kill worker process and dispatch next request immediately (no delay)
    const child = (executor as any).child;
    child.kill('SIGKILL');

    // Next request should automatically spawn a fresh worker and succeed without race condition
    const second = await executor.execute({
      requestId: 'f2',
      name: 'read_file',
      input: { path: 'test.txt' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    assert.equal(second.output, 'content');
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ProcessExecutor handles cancellation race when worker terminates concurrently without crashing', async () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'test.txt'), 'content');
  const executor = new ProcessExecutor();
  try {
    const controller = new AbortController();
    const promise = executor.execute(
      {
        requestId: 'race-cancel',
        name: 'read_file',
        input: { path: 'test.txt' },
        workspace: dir,
        timeoutMs: 5000,
        maxOutputBytes: 100,
      },
      controller.signal,
    );

    const child = (executor as any).child;
    child.kill('SIGKILL');
    controller.abort();

    await assert.rejects(promise, /(工具执行进程退出|已取消|EPIPE)/);
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file accurately differentiates between missing text and multiple occurrences', async () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'test.txt'), 'hello world hello');
  const executor = new ProcessExecutor();
  try {
    const missing = await executor.execute({
      requestId: 'm1',
      name: 'edit_file',
      input: { path: 'test.txt', oldText: 'nonexistent', newText: 'replacement' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    assert.equal(missing.isError, true);
    assert.match(missing.output, /未找到要替换的文本/);

    const multiple = await executor.execute({
      requestId: 'm2',
      name: 'edit_file',
      input: { path: 'test.txt', oldText: 'hello', newText: 'hi' },
      workspace: dir,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    assert.equal(multiple.isError, true);
    assert.match(multiple.output, /出现了 2 次，必须唯一/);
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig reports descriptive error on corrupted config file and saveConfig works', () => {
  const dir = temp();
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  try {
    fs.mkdirSync(process.env.BRUIN_HOME, { recursive: true });
    fs.writeFileSync(configPath(), '{ invalid json');
    assert.throws(() => loadConfig(), /配置文件解析失败/);

    fs.writeFileSync(configPath(), JSON.stringify({ profiles: 'not-an-array' }));
    assert.throws(() => loadConfig(), /配置文件格式无效/);

    fs.writeFileSync(configPath(), 'null');
    assert.throws(() => loadConfig(), /配置文件格式无效/);

    fs.writeFileSync(configPath(), JSON.stringify({ profiles: [null] }));
    assert.throws(() => loadConfig(), /配置文件格式无效/);

    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        profiles: [
          { alias: 'legacy', provider: 'openai', model: 'test', contextWindowTokens: 2_000_000 },
        ],
      }),
    );
    assert.equal(loadConfig().profiles[0].contextWindowTokens, 1_048_576);

    saveConfig({ profiles: [], marketplaces: [], mcpServers: [], hooks: [] });
    const loaded = loadConfig();
    assert.deepEqual(loaded.profiles, []);
  } finally {
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withConfigLock supports reentrancy, stale lock cleanup, and updateConfig atomic mutation', () => {
  const dir = temp();
  const oldHome = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  try {
    // 1. Reentrancy
    let reached = false;
    withConfigLock(() => {
      withConfigLock(() => {
        reached = true;
      });
    });
    assert.equal(reached, true);

    // 2. updateConfig serializes mutations correctly
    updateConfig((cfg) => {
      cfg.defaultProfile = 'profile-a';
      return cfg;
    });
    assert.equal(loadConfig().defaultProfile, 'profile-a');

    updateConfig((cfg) => {
      cfg.mcpServers.push({
        name: 'srv1',
        transport: 'stdio',
        command: 'node',
        args: [],
        envNames: [],
      });
      return cfg;
    });
    const loaded = loadConfig();
    assert.equal(loaded.defaultProfile, 'profile-a');
    assert.equal(loaded.mcpServers.length, 1);
    assert.equal(loaded.mcpServers[0].name, 'srv1');

    // 3. Stale lock recovery: write an old expired lock file
    const lockFile = configLockPath();
    fs.mkdirSync(process.env.BRUIN_HOME, { recursive: true });
    // Write fake dead pid and expired timestamp
    fs.writeFileSync(lockFile, `99999999\n${Date.now() - 20000}`);
    assert.equal(fs.existsSync(lockFile), true);

    // withConfigLock should detect stale lock, clean it, and acquire successfully
    const res = withConfigLock(() => 'recovered');
    assert.equal(res, 'recovered');
    assert.equal(fs.existsSync(lockFile), false);

    // A live owner must keep its lock even if the timestamp is old.
    const liveLock = `${process.pid}\n${Date.now() - 20000}`;
    fs.writeFileSync(lockFile, liveLock);
    assert.throws(() => withConfigLock(() => 'stolen'), /获取配置文件锁超时/);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), liveLock);
  } finally {
    if (oldHome === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent handles shell tool in unmaterialized managed workspace and gracefully reports deleted workspace', async () => {
  const dir = fs.realpathSync(temp());
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const managedDir = path.join(dir, 'workspaces', '20260928-120000-11223344');
    const session = store.createManagedSession(managedDir, profile);
    assert.equal(fs.existsSync(managedDir), false);

    let count = 0;
    const gateway: ModelGateway = {
      async complete() {
        count++;
        return count === 1
          ? {
              text: '',
              calls: [{ id: 'call-shell', name: 'shell', input: { command: 'echo hi' } }],
            }
          : { text: 'done', calls: [] };
      },
    };
    const executed: ToolRequest[] = [];
    const executor: ToolExecutor = {
      async execute(req: ToolRequest): Promise<ToolResult> {
        executed.push(req);
        return { output: 'hi\n', isError: false };
      },
      async close() {},
    };
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      async approve() {
        return true;
      },
    });

    await runner.run(session, 'run command');
    // Managed workspace should have been materialized before shell execution
    assert.equal(fs.existsSync(managedDir), true);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].name, 'shell');

    // Case 2: Deleted unmanaged workspace returns clean error without crashing runner
    const unmanagedDir = path.join(dir, 'deleted_unmanaged');
    const unmanagedSession = store.createSession(unmanagedDir, profile);
    count = 0;
    const runner2 = new AgentRunner(store, gateway, executor, {
      text() {},
      notice() {},
      async approve() {
        return true;
      },
    });
    await runner2.run(unmanagedSession, 'run command in missing workspace');
    const events = store.events(unmanagedSession.id);
    const finished = events.find((e) => e.type === 'tool_finished');
    assert.ok(finished);
    assert.equal(finished.payload.output, '工作区目录不存在');
    assert.equal(finished.payload.isError, true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent retries transient network errors such as ECONNRESET or fetch failed', async () => {
  const dir = fs.realpathSync(temp());
  const store = new SqliteEventStore(path.join(dir, 'db.sqlite'));
  try {
    const session = store.createSession(dir, profile);
    let attempts = 0;
    const gateway: ModelGateway = {
      async complete() {
        attempts++;
        if (attempts === 1) {
          const err = new Error('fetch failed');
          (err as { code?: string }).code = 'UND_ERR_CONNECT_TIMEOUT';
          throw err;
        }
        return { text: 'recovered', calls: [] };
      },
    };
    const executor: ToolExecutor = {
      async execute(): Promise<ToolResult> {
        return { output: 'ok', isError: false };
      },
      async close() {},
    };
    const notices: string[] = [];
    const runner = new AgentRunner(store, gateway, executor, {
      text() {},
      notice(msg) {
        notices.push(msg);
      },
      async approve() {
        return true;
      },
    });

    await runner.run(session, 'say hello');
    assert.equal(attempts, 2);
    assert.ok(notices.some((n) => n.includes('模型服务暂忙 (UND_ERR_CONNECT_TIMEOUT)')));
    const events = store.events(session.id);
    const assistant = events.find((e) => e.type === 'assistant');
    assert.equal(assistant?.payload.text, 'recovered');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace file operations reject root directory and oversized content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-root-check-'));
  try {
    assert.throws(() => readWorkspaceFile(dir, '.'), /路径不能是工作区根目录/);
    assert.throws(() => writeWorkspaceFile(dir, '.', 'content'), /路径不能是工作区根目录/);
    assert.throws(
      () => writeWorkspaceFile(dir, 'huge.txt', 'x'.repeat(10_000_001)),
      /单次写入文件大小不能超过 10MB/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
