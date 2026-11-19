import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteEventStore } from '../storage/event-store.js';
import { RuntimeServices } from '../runtime/services.js';
import { createSubagentRunner } from '../runtime/subagent.js';
import { ProcessExecutor, type ToolExecutor } from '../executor/client.js';
import { loadConfig, saveConfig } from '../config.js';
import type { ModelGateway } from '../providers/gateway.js';
import type { ToolCall } from '../core/types.js';
import { toolsForMode } from '../core/tools.js';
import { AgentRunner } from '../core/agent.js';
import { buildWorkspacePatch, preflightWorkspacePatches } from '../core/workspace-patch.js';

function fixture(t: TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-child-worktree-')));
  const previous = process.env.BRUIN_HOME;
  process.env.BRUIN_HOME = path.join(dir, 'home');
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' });
  git(['init', '-q']);
  fs.writeFileSync(path.join(root, 'source.txt'), 'base');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'scoped.txt'), 'scoped base');
  git(['add', '.']);
  git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'base',
  ]);
  const store = new SqliteEventStore(path.join(dir, 'home', 'sessions.sqlite'));
  const session = store.createSession(root, { alias: 'test', provider: 'openai', model: 'mock' });
  const executor = new ProcessExecutor();
  const runtimes: RuntimeServices[] = [];
  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    await executor.close();
    store.close();
    if (previous === undefined) delete process.env.BRUIN_HOME;
    else process.env.BRUIN_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const runtime = (gateway: () => ModelGateway, target: ToolExecutor = executor) => {
    const services = new RuntimeServices(
      store,
      target,
      createSubagentRunner(store, target, gateway),
    );
    runtimes.push(services);
    return services;
  };
  const signal = new AbortController().signal;
  return { dir, root, git, store, session, executor, runtime, signal };
}

test('two coding children run in distinct worktrees, preserve parent edits and expose durable review', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'source.txt'), 'parent uncommitted edit');
  const excludes = path.join(f.dir, 'test-excludes');
  fs.writeFileSync(excludes, '*.ignored\n');
  f.git(['config', '--local', 'core.excludesFile', excludes]);
  const release: Array<() => void> = [];
  const services = f.runtime(() => {
    let calls = 0;
    return {
      async complete(_profile, messages, signal) {
        if (++calls === 1) {
          assert.match(JSON.stringify(messages), /isolated Git worktree/);
          await new Promise<void>((resolve) => {
            release.push(resolve);
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return {
            text: '',
            calls: [
              { id: 'read', name: 'read_file', input: { path: 'source.txt' } },
              {
                id: 'write',
                name: 'write_file',
                input: { path: 'source.txt', content: 'child proposal' },
              },
              {
                id: 'add',
                name: 'write_file',
                input: { path: 'proposal.txt', content: 'new proposal' },
              },
              {
                id: 'scratch',
                name: 'write_file',
                input: { path: 'scratch.txt', content: 'temporary' },
              },
              {
                id: 'ignored',
                name: 'write_file',
                input: { path: 'proposal.ignored', content: 'explicitly written file' },
              },
            ],
          };
        }
        return { text: 'verified proposal', calls: [] };
      },
    };
  });
  const starts = await Promise.all(
    [1, 2, 3].map((n) =>
      services.execute(
        { id: String(n), name: 'spawn_subagent', input: { mode: 'worktree', prompt: `task ${n}` } },
        f.session,
        f.signal,
        { allowWorkspaceEdits: true, maxModelCalls: 96 },
      ),
    ),
  );
  assert.equal(starts.filter((result) => result.isError).length, 1);
  assert.match(starts.find((result) => result.isError)!.output, /最多同时/);
  const started = f.store.events(f.session.id).filter((event) => event.type === 'subagent_started');
  assert.equal(started.length, 2);
  const workspaces = started.map((event) => String(event.payload.workspace));
  assert.equal(new Set(workspaces).size, 2);
  for (const workspace of workspaces) {
    assert.equal(fs.readFileSync(path.join(workspace, 'source.txt'), 'utf8'), 'base');
    assert.equal(f.store.isLeased(f.session.id), true);
    const removal = await services.execute(
      { id: 'remove', name: 'remove_worktree', input: { path: workspace } },
      f.session,
      f.signal,
    );
    assert.equal(removal.isError, true);
    assert.match(removal.output, /运行中的会话/);
  }
  // Both model requests are held until we have observed simultaneous execution.
  assert.equal(release.length, 2);
  fs.writeFileSync(path.join(workspaces[0], 'source.txt'), 'changed before the agent write');
  for (const finish of release) finish();
  await services.waitForSubagents(f.session.id, f.signal);
  assert.equal(f.store.isLeased(f.session.id), false);
  for (const workspace of workspaces) {
    fs.unlinkSync(path.join(workspace, 'scratch.txt'));
    fs.writeFileSync(path.join(workspace, 'unrelated.ignored'), 'generated outside the agent');
  }
  fs.unlinkSync(path.join(workspaces[0], 'nested', 'scoped.txt'));
  f.git(['-C', workspaces[0], 'add', '-u']);
  f.git([
    '-C',
    workspaces[0],
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'record proposal without changing parent',
  ]);
  assert.equal(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'parent uncommitted edit');
  const restored = f.runtime(() => {
    throw new Error('must not restart children');
  });
  for (const runtime of [services, restored]) {
    for (const event of started) {
      const id = String(event.payload.childId);
      const status = JSON.parse(
        (
          await runtime.execute(
            { id: 'status', name: 'subagent_status', input: { id } },
            f.session,
            f.signal,
          )
        ).output,
      );
      assert.equal(status.status, 'completed');
      assert.equal(status.mode, 'worktree');
      assert.equal(status.answer, 'verified proposal');
      assert.equal(status.baseCommit, f.git(['rev-parse', 'HEAD']).trim());
      assert.equal(status.reviewError, undefined);
      assert.deepEqual(status.changes, [
        ...(event === started[0]
          ? [{ path: 'nested/scoped.txt', source: 'workspace', status: 'deleted' }]
          : []),
        { path: 'proposal.ignored', source: 'agent', status: 'added' },
        { path: 'proposal.txt', source: 'agent', status: 'added' },
        { path: 'source.txt', source: 'agent', status: 'modified' },
      ]);
      const review = await runtime.execute(
        { id: 'review', name: 'subagent_review', input: { id, path: 'source.txt' } },
        f.session,
        f.signal,
      );
      assert.equal(review.isError, false, review.output);
      assert.equal(JSON.parse(review.output).content, 'child proposal');
      assert.equal(JSON.parse(review.output).baselineContent, 'base');
      const added = await runtime.execute(
        { id: 'review-added', name: 'subagent_review', input: { id, path: 'proposal.txt' } },
        f.session,
        f.signal,
      );
      assert.equal(added.isError, false, added.output);
      assert.equal(JSON.parse(added.output).content, 'new proposal');
      assert.equal(JSON.parse(added.output).baselineContent, '');
      if (event === started[0]) {
        const removed = await runtime.execute(
          {
            id: 'review-deleted',
            name: 'subagent_review',
            input: { id, path: 'nested/scoped.txt' },
          },
          f.session,
          f.signal,
        );
        assert.equal(removed.isError, false, removed.output);
        assert.equal(JSON.parse(removed.output).content, '');
        assert.equal(JSON.parse(removed.output).baselineContent, 'scoped base');
      }
      const escape = await runtime.execute(
        { id: 'escape', name: 'subagent_review', input: { id, path: '../outside' } },
        f.session,
        f.signal,
      );
      assert.equal(escape.isError, true);
      const stranger = f.store.createSession(f.root, f.session.profile);
      assert.equal(
        (
          await runtime.execute(
            { id: 'cross', name: 'subagent_review', input: { id, path: 'source.txt' } },
            stranger,
            f.signal,
          )
        ).isError,
        true,
      );
    }
  }
  const id = String(started[0].payload.childId);
  const childWorkspace = workspaces[0];
  const binary = Buffer.from([0, 10, 255, 20]);
  fs.writeFileSync(path.join(childWorkspace, 'binary file.dat'), binary);
  if (process.platform !== 'win32')
    fs.symlinkSync('proposal.txt', path.join(childWorkspace, 'link.txt'));
  const parentState = f.git(['status', '--porcelain']);
  const childState = f.git(['-C', childWorkspace, 'status', '--porcelain']);
  const objects = f.git(['count-objects', '-v']);
  const childIndexPath = f
    .git(['-C', childWorkspace, 'rev-parse', '--path-format=absolute', '--git-path', 'index'])
    .trim();
  const childIndex = fs.readFileSync(childIndexPath);
  const patch = await restored.exportSubagentPatch(f.session.id, id);
  const output = Buffer.from(patch.contentBase64, 'base64');
  assert.match(output.toString('utf8'), /GIT binary patch/);
  assert.equal(f.git(['count-objects', '-v']), objects);
  assert.deepEqual(fs.readFileSync(childIndexPath), childIndex);
  assert.equal(f.git(['status', '--porcelain']), parentState);
  assert.equal(f.git(['-C', childWorkspace, 'status', '--porcelain']), childState);
  const applied = path.join(f.dir, 'applied');
  f.git(['worktree', 'add', '-q', '--detach', applied, patch.baseCommit]);
  execFileSync('git', ['apply', '--check', '-'], { cwd: applied, input: output });
  execFileSync('git', ['apply', '-'], { cwd: applied, input: output });
  assert.equal(fs.readFileSync(path.join(applied, 'source.txt'), 'utf8'), 'child proposal');
  assert.equal(fs.readFileSync(path.join(applied, 'proposal.txt'), 'utf8'), 'new proposal');
  assert.equal(
    fs.readFileSync(path.join(applied, 'proposal.ignored'), 'utf8'),
    'explicitly written file',
  );
  assert.equal(fs.existsSync(path.join(applied, 'nested', 'scoped.txt')), false);
  assert.equal(fs.existsSync(path.join(applied, 'unrelated.ignored')), false);
  assert.deepEqual(fs.readFileSync(path.join(applied, 'binary file.dat')), binary);
  if (process.platform !== 'win32')
    assert.equal(fs.readlinkSync(path.join(applied, 'link.txt')), 'proposal.txt');
});

test('patch export rejects a baseline Git submodule deleted or replaced in a child worktree', async (t) => {
  const f = fixture(t);
  const commit = f.git(['rev-parse', 'HEAD']).trim();
  f.git(['update-index', '--add', '--cacheinfo', `160000,${commit},dependency`]);
  f.git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'record dependency',
  ]);
  const services = f.runtime(() => ({
    async complete() {
      return { text: 'proposal ready', calls: [] };
    },
  }));
  const started = await services.execute(
    { id: 'spawn', name: 'spawn_subagent', input: { mode: 'worktree', prompt: 'inspect files' } },
    f.session,
    f.signal,
    { allowWorkspaceEdits: true },
  );
  assert.equal(started.isError, false, started.output);
  await services.waitForSubagents(f.session.id, f.signal);
  const delegation = f.store
    .events(f.session.id)
    .find((event) => event.type === 'subagent_started')!;
  const id = String(delegation.payload.childId);
  const workspace = String(delegation.payload.workspace);
  const dependency = path.join(workspace, 'dependency');
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'ordinary file edit');
  const patch = await services.exportSubagentPatch(f.session.id, id);
  assert.match(Buffer.from(patch.contentBase64, 'base64').toString('utf8'), /\+ordinary file edit/);
  fs.rmdirSync(dependency);
  await assert.rejects(services.exportSubagentPatch(f.session.id, id), /子模块.*dependency/);
  fs.writeFileSync(dependency, 'replaced with a regular file');
  await assert.rejects(services.exportSubagentPatch(f.session.id, id), /子模块.*dependency/);
});

for (const directoryFirst of [false, true]) {
  test(`joint preflight reports file and directory collisions (directory first=${directoryFirst})`, async (t) => {
    const f = fixture(t);
    const baseCommit = f.git(['rev-parse', 'HEAD']).trim();
    const fileChild = path.join(f.dir, 'file-child');
    const directoryChild = path.join(f.dir, 'directory-child');
    for (const child of [fileChild, directoryChild])
      f.git(['worktree', 'add', '-q', '--detach', child, baseCommit]);
    const name = '新 文件';
    const nested = name + '/child.txt';
    fs.writeFileSync(path.join(fileChild, name), 'ordinary file\n');
    fs.mkdirSync(path.join(directoryChild, name));
    fs.writeFileSync(path.join(directoryChild, nested), 'nested file\n');
    const ordered = directoryFirst ? [directoryChild, fileChild] : [fileChild, directoryChild];
    const patches = await Promise.all(
      ordered.map(async (workspace) => ({
        childId: path.basename(workspace),
        workspace,
        content: await buildWorkspacePatch(workspace, [], baseCommit, f.signal),
      })),
    );
    f.git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--no-gpg-sign',
      '--allow-empty',
      '-qm',
      'advance parent HEAD',
    ]);
    const result = await preflightWorkspacePatches(f.root, baseCommit, patches, f.signal);
    assert.equal(result.status, 'conflict', result.detail);
    assert.deepEqual(result.conflictPaths, [directoryFirst ? name : nested]);
    assert.equal(result.failedChildId, patches[1].childId);
    assert.deepEqual(result.checked, [patches[0].childId]);
    assert.equal(result.baseCommit, baseCommit);
    assert.notEqual(f.git(['rev-parse', 'HEAD']).trim(), baseCommit);
    assert.equal(fs.readFileSync(path.join(fileChild, name), 'utf8'), 'ordinary file\n');
    assert.equal(fs.readFileSync(path.join(directoryChild, nested), 'utf8'), 'nested file\n');
  });
}

test('joint preflight rejects a result if the parent session changed the workspace', async (t) => {
  const f = fixture(t);
  const baseCommit = f.git(['rev-parse', 'HEAD']).trim();
  const childIds: string[] = [];
  for (const name of ['addition-a', 'addition-b']) {
    const workspace = path.join(f.dir, name);
    f.git(['worktree', 'add', '-q', '--detach', workspace, baseCommit]);
    fs.writeFileSync(path.join(workspace, name + '.txt'), 'proposed file\n');
    const child = f.store.createSession(workspace, f.session.profile);
    childIds.push(child.id);
    f.store.append(f.session.id, 'subagent_started', {
      childId: child.id,
      mode: 'worktree',
      baseCommit,
      workspace,
    });
  }
  const testedWorktrees: string[] = [];
  const services = f.runtime(
    () => {
      throw new Error('preflight must not call a model');
    },
    {
      async execute(request) {
        assert.equal(request.name, 'shell');
        assert.deepEqual(request.input, { command: 'npm test' });
        assert.equal(request.requireSandbox, true);
        assert.equal(request.workspaceOnlyWrites, true);
        for (const name of ['addition-a', 'addition-b'])
          assert.equal(
            fs.readFileSync(path.join(request.workspace, name + '.txt'), 'utf8'),
            'proposed file\n',
          );
        testedWorktrees.push(request.workspace);
        return { isError: false, exitCode: 0, output: 'both changes passed' };
      },
      async close() {},
    },
  );
  f.git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '--no-gpg-sign',
    '--allow-empty',
    '-qm',
    'new baseline',
  ]);
  const newerBase = f.git(['rev-parse', 'HEAD']).trim();
  const newerWorkspace = path.join(f.dir, 'newer-child');
  f.git(['worktree', 'add', '-q', '--detach', newerWorkspace, newerBase]);
  const newer = f.store.createSession(newerWorkspace, f.session.profile);
  f.store.append(f.session.id, 'subagent_started', {
    childId: newer.id,
    mode: 'worktree',
    baseCommit: newerBase,
    workspace: newerWorkspace,
  });
  await assert.rejects(
    services.preflightSubagentPatches(f.session, [childIds[0], newer.id]),
    /同一个启动提交/,
  );
  const tested = await services.preflightSubagentPatches(f.session, childIds, 'npm test');
  assert.equal(tested.test?.output, 'both changes passed');
  assert.equal(testedWorktrees.length, 1);
  assert.equal(fs.existsSync(testedWorktrees[0]), false);
  const pending = services.preflightSubagentPatches(f.session, childIds, 'npm test');
  f.store.setWorkspace(f.session.id, path.join(f.root, 'nested'));
  await assert.rejects(pending, /会话工作区已改变/);
  assert.equal(testedWorktrees.length, 1);
  assert.ok(childIds.every((id) => !f.store.isLeased(id)));
});

test('coding children require current file authorization and cannot reuse a workspace', async (t) => {
  const f = fixture(t);
  const services = f.runtime(() => {
    throw new Error('must not run');
  });
  for (const [input, settings] of [
    [{ mode: 'worktree', prompt: 'edit' }, {}],
    [{ mode: 'worktree', prompt: 'edit', worktree: f.root }, { allowWorkspaceEdits: true }],
  ] as const) {
    const result = await services.execute(
      { id: 'spawn', name: 'spawn_subagent', input },
      f.session,
      f.signal,
      settings,
    );
    assert.equal(result.isError, true);
  }
  assert.equal(f.store.listSessions().length, 1);
  assert.equal(f.store.isLeased(f.session.id), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'home', 'worktrees')), false);
});

test('coding children only inherit matching saved commands and always require a shell sandbox', async (t) => {
  const f = fixture(t);
  saveConfig({
    ...loadConfig(),
    approvedCommands: [
      { workspace: f.root, command: 'verify-child', sessionId: f.session.id },
      { workspace: f.root, command: 'other-session', sessionId: 'another-session' },
      { workspace: f.dir, command: 'other-workspace' },
    ],
  });
  const executed: string[] = [];
  const executor: ToolExecutor = {
    async execute(request) {
      assert.equal(request.name, 'shell');
      assert.equal(request.requireSandbox, true);
      executed.push(String(request.input.command));
      return { output: 'verified', isError: false };
    },
    async close() {},
  };
  const calls: ToolCall[] = [
    ...['verify-child', 'other-session', 'other-workspace', 'unapproved', 'git merge main'].map(
      (command, n) => ({ id: `shell-${n}`, name: 'shell' as const, input: { command } }),
    ),
    { id: 'metadata', name: 'write_file', input: { path: '.GIT', content: 'corrupt metadata' } },
    {
      id: 'outside',
      name: 'write_file',
      input: { path: path.join(f.root, 'source.txt'), content: 'escape' },
    },
    { id: 'nested', name: 'spawn_subagent', input: { prompt: 'spawn more' } },
    { id: 'mcp', name: 'mcp_call', input: { server: 'external', tool: 'action' } },
  ];
  const services = f.runtime(() => {
    let sent = false;
    return {
      async complete() {
        if (!sent) {
          sent = true;
          return { text: '', calls };
        }
        return { text: 'done', calls: [] };
      },
    };
  }, executor);
  const start = await services.execute(
    { id: 'spawn', name: 'spawn_subagent', input: { mode: 'worktree', prompt: 'verify' } },
    f.session,
    f.signal,
    { allowWorkspaceEdits: true },
  );
  const id = start.output.split(': ')[1];
  await services.waitForSubagents(f.session.id, f.signal);
  assert.deepEqual(executed, ['verify-child']);
  const denied = f.store.events(id).filter((event) => event.type === 'tool_denied');
  assert.equal(denied.length, calls.length - 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'base');
  assert.deepEqual(Object.keys(toolsForMode('worktree')).sort(), [
    'edit_file',
    'list_files',
    'list_snapshots',
    'load_skill',
    'read_file',
    'search',
    'search_repository',
    'shell',
    'write_file',
  ]);
});

test('coding cancellation keeps the worktree and releases both session leases', async (t) => {
  const f = fixture(t);
  let inModel!: () => void;
  const entered = new Promise<void>((resolve) => {
    inModel = resolve;
  });
  let calls = 0;
  const services = f.runtime(() => ({
    async complete(_profile, _messages, signal) {
      if (++calls === 1)
        return {
          text: '',
          calls: [
            { id: 'read', name: 'read_file', input: { path: 'source.txt' } },
            {
              id: 'write',
              name: 'write_file',
              input: { path: 'source.txt', content: 'incomplete proposal' },
            },
          ],
        };
      inModel();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      );
    },
  }));
  const started = await services.execute(
    { id: 'spawn', name: 'spawn_subagent', input: { mode: 'worktree', prompt: 'wait' } },
    f.session,
    f.signal,
    { allowWorkspaceEdits: true },
  );
  const id = started.output.split(': ')[1];
  await entered;
  const observerStore = new SqliteEventStore(path.join(f.dir, 'home', 'sessions.sqlite'));
  const observer = new RuntimeServices(observerStore, f.executor, async () => {});
  try {
    const remote = await observer.execute(
      { id: 'remote-stop', name: 'cancel_subagent', input: { id } },
      f.session,
      f.signal,
    );
    assert.equal(remote.isError, true);
    assert.match(remote.output, /持有.*租约/);
    assert.equal(observerStore.isLeased(id), true);
  } finally {
    await observer.close();
    observerStore.close();
  }
  const stranger = f.store.createSession(f.root, f.session.profile);
  assert.equal(
    (
      await services.execute(
        { id: 'other', name: 'cancel_subagent', input: { id } },
        stranger,
        f.signal,
      )
    ).isError,
    true,
  );
  await services.execute(
    { id: 'stop', name: 'cancel_subagent', input: { id } },
    f.session,
    f.signal,
  );
  await services.waitForSubagents(f.session.id, f.signal);
  assert.equal(f.store.isLeased(f.session.id), false);
  assert.equal(f.store.isLeased(id), false);
  const status = JSON.parse(
    (
      await services.execute(
        { id: 'status', name: 'subagent_status', input: { id } },
        f.session,
        f.signal,
      )
    ).output,
  );
  assert.equal(status.status, 'failed');
  assert.ok(fs.existsSync(status.workspace));
  assert.equal(
    fs.readFileSync(path.join(status.workspace, 'source.txt'), 'utf8'),
    'incomplete proposal',
  );
  assert.equal(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'base');
  assert.equal(
    f.store.events(f.session.id).filter((event) => event.type === 'subagent_finished').length,
    1,
  );
});

test('parent run forwards its current delegation permission and model budget', async (t) => {
  const f = fixture(t);
  let childCalls = 0;
  const services = f.runtime(() => ({
    async complete() {
      if (++childCalls <= 25)
        return {
          text: '',
          calls: [{ id: `read-${childCalls}`, name: 'read_file', input: { path: 'source.txt' } }],
        };
      return { text: 'child done', calls: [] };
    },
  }));
  let step = 0;
  const runner = new AgentRunner(
    f.store,
    {
      async complete() {
        if (++step === 1)
          return {
            text: '',
            calls: [
              { id: 'spawn', name: 'spawn_subagent', input: { mode: 'worktree', prompt: 'edit' } },
            ],
          };
        return { text: 'summary', calls: [] };
      },
    },
    f.executor,
    {
      text() {},
      notice() {},
      async approve() {
        return true;
      },
    },
    services,
  );
  await runner.run(f.session, 'delegate', f.signal, [], undefined, {
    maxModelCalls: 96,
    allowWorkspaceEdits: true,
  });
  const events = f.store.events(f.session.id);
  const callStarted = events.find((event) => event.type === 'tool_started');
  assert.equal(callStarted?.payload.name, 'spawn_subagent');
  const childStarted = events.find((event) => event.type === 'subagent_started');
  assert.equal(childStarted?.payload.toolStartedSeq, callStarted?.seq);
  const finished = events.find((event) => event.type === 'subagent_finished');
  assert.equal(finished?.payload.status, 'completed');
  assert.equal(finished?.payload.mode, 'worktree');
  assert.equal(childCalls, 26);
  assert.equal(
    f.store
      .events(String(finished?.payload.childId))
      .filter((event) => event.type === 'turn_checkpoint').length,
    1,
  );
});

test('coding children preserve repository subdirectory scope', async (t) => {
  const f = fixture(t);
  const base = f.git(['rev-parse', 'HEAD']).trim();
  const parent = f.store.createSession(path.join(f.root, 'nested'), f.session.profile);
  const services = f.runtime(() => {
    let calls = 0;
    return {
      async complete() {
        if (++calls === 1)
          return {
            text: '',
            calls: [
              { id: 'index', name: 'search_repository', input: { query: '' } },
              { id: 'read', name: 'read_file', input: { path: 'scoped.txt' } },
              {
                id: 'edit',
                name: 'write_file',
                input: { path: 'scoped.txt', content: 'scoped proposal' },
              },
              {
                id: 'escape',
                name: 'write_file',
                input: { path: '../source.txt', content: 'escape' },
              },
            ],
          };
        return { text: 'done', calls: [] };
      },
    };
  });
  const execute = services.execute.bind(services);
  t.mock.method(services, 'execute', async (...args: Parameters<typeof services.execute>) => {
    if (args[0].name === 'create_worktree')
      f.git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '--no-gpg-sign',
        '--allow-empty',
        '-qm',
        'advance parent HEAD during setup',
      ]);
    return execute(...args);
  });
  const started = await services.execute(
    { id: 'spawn', name: 'spawn_subagent', input: { mode: 'worktree', prompt: 'edit nested' } },
    parent,
    f.signal,
    { allowWorkspaceEdits: true },
  );
  const id = started.output.split(': ')[1];
  await services.waitForSubagents(parent.id, f.signal);
  const child = f.store.getSession(id)!;
  assert.notEqual(f.git(['rev-parse', 'HEAD']).trim(), base);
  assert.equal(f.git(['-C', child.workspace, 'rev-parse', 'HEAD']).trim(), base);
  assert.equal(path.basename(child.workspace), 'nested');
  assert.equal(
    fs.readFileSync(path.join(child.workspace, 'scoped.txt'), 'utf8'),
    'scoped proposal',
  );
  assert.equal(fs.readFileSync(path.join(child.workspace, '../source.txt'), 'utf8'), 'base');
  assert.equal(fs.readFileSync(path.join(parent.workspace, 'scoped.txt'), 'utf8'), 'scoped base');
  const childEvents = f.store.events(id);
  const indexed = childEvents.find(
    (event) => event.type === 'tool_finished' && event.payload.callId === 'index',
  );
  assert.equal(indexed?.payload.isError, false);
  const index = JSON.parse(String(indexed?.payload.output));
  assert.equal(index.gitIgnore, true);
  assert.deepEqual(
    index.results.map((item: { path: string }) => item.path),
    ['scoped.txt'],
  );
  assert.ok(
    childEvents.some((event) => event.type === 'tool_denied' && event.payload.callId === 'escape'),
  );
  fs.writeFileSync(path.join(child.workspace, '../source.txt'), 'changed outside the chosen scope');
  const status = await services.execute(
    { id: 'status', name: 'subagent_status', input: { id } },
    parent,
    f.signal,
  );
  assert.deepEqual(JSON.parse(status.output).changes, [
    { path: 'scoped.txt', source: 'agent', status: 'modified' },
  ]);
  const review = await services.execute(
    { id: 'review', name: 'subagent_review', input: { id, path: 'scoped.txt' } },
    parent,
    f.signal,
  );
  assert.equal(review.isError, false, review.output);
  assert.equal(JSON.parse(review.output).baselineContent, 'scoped base');
  const patch = await services.exportSubagentPatch(parent.id, id);
  assert.equal(patch.baseCommit, base);
  const text = Buffer.from(patch.contentBase64, 'base64').toString('utf8');
  assert.match(text, /diff --git a\/nested\/scoped.txt b\/nested\/scoped.txt/);
  assert.doesNotMatch(text, /source.txt|changed outside/);
});

for (const name of ['new directory', 'source.txt']) {
  test(`coding child rejects a scope without a directory at its baseline (${name})`, async (t) => {
    const f = fixture(t);
    const workspace = path.join(f.root, name);
    if (fs.existsSync(workspace)) fs.unlinkSync(workspace);
    fs.mkdirSync(workspace);
    const draft = path.join(workspace, 'draft.txt');
    fs.writeFileSync(draft, 'uncommitted user work');
    const before = f.git(['status', '--porcelain=v1']);
    const parent = f.store.createSession(workspace, f.session.profile);
    const services = f.runtime(() => {
      throw new Error('must not start');
    });
    const result = await services.execute(
      { id: 'spawn', name: 'spawn_subagent', input: { mode: 'worktree', prompt: 'edit' } },
      parent,
      f.signal,
      { allowWorkspaceEdits: true },
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /启动提交.*目录/);
    assert.equal(fs.existsSync(path.join(f.dir, 'home', 'worktrees')), false);
    assert.equal(f.store.listSessions().length, 2);
    assert.equal(f.store.isLeased(parent.id), false);
    assert.deepEqual(f.store.events(parent.id), []);
    assert.equal(f.git(['status', '--porcelain=v1']), before);
    assert.equal(fs.readFileSync(draft, 'utf8'), 'uncommitted user work');
  });
}

test('closing during worktree setup cancels the start and releases its reservation and lease', async (t) => {
  const f = fixture(t);
  const services = f.runtime(() => {
    throw new Error('must not start');
  });
  const execute = services.execute.bind(services);
  let blocked!: () => void;
  const entered = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  t.mock.method(services, 'execute', async (...args: Parameters<typeof services.execute>) => {
    if (args[0].name === 'create_worktree') {
      blocked();
      return new Promise((_resolve, reject) =>
        args[2].addEventListener('abort', () => reject(new Error('setup cancelled')), {
          once: true,
        }),
      );
    }
    return execute(...args);
  });
  const starting = services.execute(
    { id: 'spawn', name: 'spawn_subagent', input: { mode: 'worktree', prompt: 'edit' } },
    f.session,
    f.signal,
    { allowWorkspaceEdits: true },
  );
  const rejected = assert.rejects(starting, /setup cancelled/);
  await entered;
  await services.close();
  await rejected;
  assert.equal(f.store.isLeased(f.session.id), false);
  assert.equal(f.store.listSessions().length, 1);
  const retry = await execute(
    { id: 'retry', name: 'spawn_subagent', input: { prompt: 'more' } },
    f.session,
    f.signal,
  );
  assert.equal(retry.isError, true);
  assert.match(retry.output, /关闭/);
});

test('failed worktree setup releases the parent lease without starting a child', async (t) => {
  const f = fixture(t);
  const plain = path.join(f.dir, 'not-a-repo');
  fs.mkdirSync(plain);
  const parent = f.store.createSession(plain, f.session.profile);
  const services = f.runtime(() => {
    throw new Error('must not start');
  });
  await assert.rejects(
    services.execute(
      { id: 'spawn', name: 'spawn_subagent', input: { mode: 'worktree', prompt: 'edit' } },
      parent,
      f.signal,
      { allowWorkspaceEdits: true },
    ),
  );
  assert.equal(f.store.isLeased(parent.id), false);
  assert.equal(f.store.listSessions().length, 2);
  assert.equal(f.store.events(parent.id).length, 0);
});

test('a failure to record a created worktree reports its retained path and releases its leases', async (t) => {
  const f = fixture(t);
  const services = f.runtime(() => {
    throw new Error('must not start');
  });
  const append = f.store.append.bind(f.store);
  const failure = new Error('injected delegation receipt failure');
  t.mock.method(f.store, 'append', (...args: Parameters<typeof append>) => {
    if (args[1] === 'subagent_started') throw failure;
    return append(...args);
  });
  const worktrees = path.join(f.dir, 'home', 'worktrees');
  await assert.rejects(
    services.execute(
      { id: 'spawn', name: 'spawn_subagent', input: { mode: 'worktree', prompt: 'edit' } },
      f.session,
      f.signal,
      { allowWorkspaceEdits: true },
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, failure);
      const names = fs.readdirSync(worktrees);
      assert.equal(names.length, 1);
      assert.ok(error.message.includes(path.join(worktrees, names[0])));
      return true;
    },
  );
  assert.equal(f.store.events(f.session.id).length, 0);
  assert.equal(
    f.store.listSessions().some((session) => f.store.isLeased(session.id)),
    false,
  );
});
