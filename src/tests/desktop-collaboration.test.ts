import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SqliteEventStore } from '../storage/event-store.js';

test(
  'desktop RPC supports isolated coding, live review and steering while a parent waits',
  { timeout: 15_000 },
  async (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-desktop-collab-')));
    const root = path.join(dir, 'repo');
    fs.mkdirSync(root);
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git(['init', '-q']);
    fs.writeFileSync(path.join(root, 'source.txt'), 'base');
    fs.writeFileSync(path.join(root, 'independent.txt'), 'base independent\n');
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
    fs.writeFileSync(path.join(root, 'source.txt'), 'parent edit');
    const preloader = path.join(dir, 'provider.mjs');
    fs.writeFileSync(
      preloader,
      `
import fs from 'node:fs';
import path from 'node:path';
import { SqliteEventStore } from ${JSON.stringify(new URL('../storage/event-store.js', import.meta.url).href)};
const append = SqliteEventStore.prototype.append;
SqliteEventStore.prototype.append = function (id, type, payload) {
  if (type === 'tool_requested' && payload.source === 'desktop' && payload.name === 'spawn_subagent' && !this.isLeased(id))
    throw new Error('desktop spawn request was written without the parent lease');
  if (type === 'subagent_finished' && payload.recovered) {
    if (!this.isLeased(id)) throw new Error('recovery wrote a child receipt without the parent lease');
    if (fs.existsSync(path.join(process.env.BRUIN_TEST_STATE, 'fail-receipt'))) throw new Error('injected recovery failure');
  }
  return append.call(this, id, type, payload);
};
const counts = new Map();
let parentChildId;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'http://localhost:9999/v1/chat/completions') throw new Error('Unexpected URL');
  const body = JSON.parse(init.body);
  const calls = new Set();
  for (const message of body.messages) {
    for (const call of message.tool_calls ?? []) calls.add(call.id);
    if (message.role === 'tool' && !calls.delete(message.tool_call_id))
      throw new Error('Tool result without a model call');
  }
  const user = JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1));
  const label = user.includes('PARENT_INVESTIGATE') || user.includes('STOP_RESEARCH') ? 'PARENT' :
    user.includes('CHILD_THREE') ? 'CHILD_THREE' : user.includes('CHILD_ONE') ? 'CHILD_ONE' : 'CHILD_TWO';
  const count = (counts.get(label) ?? 0) + 1;
  counts.set(label, count);
  const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
    id: label + count, object: 'chat.completion.chunk', created: 1, model: 'mock',
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\\n\\n';
  let response;
  if (label === 'PARENT') {
    if (count === 1) response = chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'delegate',
      type: 'function', function: { name: 'spawn_subagent', arguments: JSON.stringify({ mode: 'worktree', prompt: 'CHILD_THREE' }) } }] }, null) + chunk({}, 'tool_calls');
    else if (count === 2) {
      parentChildId = [...JSON.stringify(body.messages).matchAll(/子 Agent 已启动: ([a-f0-9-]{36})/g)].at(-1)?.[1];
      if (!parentChildId) throw new Error('Missing delegated child ID');
      fs.writeFileSync(path.join(process.env.BRUIN_TEST_STATE, 'PARENT.ready'), 'ready');
      response = chunk({ role: 'assistant', content: 'Waiting for research.' }, null) + chunk({}, 'stop');
    } else if (count === 3) {
      if (!user.includes('STOP_RESEARCH')) throw new Error('Steering did not reach parent');
      response = chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'stop-child',
        type: 'function', function: { name: 'cancel_subagent', arguments: JSON.stringify({ id: parentChildId }) } }] }, null) + chunk({}, 'tool_calls');
    } else response = chunk({ role: 'assistant', content: 'Stopped research.' }, null) + chunk({}, 'stop');
  } else if (count === 1) response = chunk({ role: 'assistant', tool_calls: [
    { index: 0, id: label + '-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'source.txt' }) } },
    { index: 1, id: label, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'source.txt', content: label + ' proposal' }) } },
  ] }, null) + chunk({}, 'tool_calls');
  else {
    fs.writeFileSync(path.join(process.env.BRUIN_TEST_STATE, label + '.ready'), 'ready');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(process.env.BRUIN_TEST_STATE, 'release'))) {
      if (init.signal?.aborted) throw new Error('cancelled');
      if (Date.now() > deadline) throw new Error('provider not released');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    response = chunk({ role: 'assistant', content: label + ' verified' }, null) + chunk({}, 'stop');
  }
  return new Response(response + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
};
`,
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(preloader).href,
        fileURLToPath(new URL('../desktop-host.js', import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          BRUIN_HOME: path.join(dir, 'home'),
          BRUIN_TEST_STATE: dir,
          BRUIN_SHELL_BACKEND: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const waiting = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
    const notifications: any[] = [];
    let nextId = 0;
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const rejectWaiting = (error: Error) => {
      for (const request of waiting.values()) request.reject(error);
      waiting.clear();
    };
    child.on('error', rejectWaiting);
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => {
        rejectWaiting(new Error(stderr || 'host exited'));
        resolve();
      }),
    );
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.type) notifications.push(message);
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    const request = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    };
    const waitUntil = async (predicate: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 8000;
      while (!(await predicate())) {
        assert.ok(Date.now() < deadline, stderr || 'collaboration timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await request('saveProfile', {
        alias: 'test',
        provider: 'openai-compatible',
        model: 'mock',
        baseUrl: 'http://localhost:9999/v1',
      });
      const { session } = await request('createSession', { workspace: root, profileAlias: 'test' });
      const tool = (name: string, input: Record<string, unknown>, extra = {}) =>
        request('runtimeTool', { sessionId: session.id, name, input, ...extra });
      const denied = await tool('spawn_subagent', { mode: 'worktree', prompt: 'CHILD_ONE' });
      assert.equal(denied.isError, true);
      const first = await tool(
        'spawn_subagent',
        { mode: 'worktree', prompt: 'CHILD_ONE' },
        { allowWorkspaceEdits: true },
      );
      assert.equal(first.isError, false, first.output);
      const firstId = first.output.split(': ')[1];
      await waitUntil(() => fs.existsSync(path.join(dir, 'CHILD_ONE.ready')));
      const second = await tool(
        'spawn_subagent',
        { mode: 'worktree', prompt: 'CHILD_TWO' },
        { allowWorkspaceEdits: true },
      );
      assert.equal(second.isError, false, second.output);
      const secondId = second.output.split(': ')[1];
      await waitUntil(() => fs.existsSync(path.join(dir, 'CHILD_TWO.ready')));
      const firstStatus = JSON.parse((await tool('subagent_status', { id: firstId })).output);
      const secondStatus = JSON.parse((await tool('subagent_status', { id: secondId })).output);
      assert.equal(firstStatus.status, 'running');
      assert.equal(secondStatus.status, 'running');
      assert.notEqual(firstStatus.workspace, secondStatus.workspace);
      const review = await tool('subagent_review', { id: firstId, path: 'source.txt' });
      assert.equal(JSON.parse(review.output).content, 'CHILD_ONE proposal');
      const prepare = (childId: string, parentId = session.id) =>
        request('prepareSubagentPatch', { sessionId: parentId, childId });
      const preflight = (childIds: string[], parentId = session.id, testCommand?: string) =>
        request('preflightSubagentPatches', { sessionId: parentId, childIds, testCommand });
      const candidates = await request('listSubagentPatches', { sessionId: session.id });
      assert.equal(candidates.length, 2);
      assert.ok(candidates.every((entry: { running: boolean }) => entry.running));
      await assert.rejects(preflight([firstId, secondId]), /结束后再导出/);
      await assert.rejects(preflight([firstId, firstId]), /不同的子任务/);
      await assert.rejects(prepare(firstId), /结束后再导出/);
      await assert.rejects(prepare(secondId, firstId), /不属于当前会话/);
      await tool('cancel_subagent', { id: firstId });
      await waitUntil(
        async () =>
          JSON.parse((await tool('subagent_status', { id: firstId })).output).status === 'failed',
      );
      const cancelled = await prepare(firstId);
      assert.equal(cancelled.baseCommit, firstStatus.baseCommit);
      assert.match(
        Buffer.from(cancelled.contentBase64, 'base64').toString('utf8'),
        /\+CHILD_ONE proposal/,
      );
      fs.writeFileSync(path.join(dir, 'release'), 'go');
      await waitUntil(
        async () =>
          JSON.parse((await tool('subagent_status', { id: secondId })).output).status ===
          'completed',
      );
      assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'parent edit');
      const exported = await prepare(secondId);
      assert.equal(exported.baseCommit, secondStatus.baseCommit);
      const patch = Buffer.from(exported.contentBase64, 'base64');
      assert.match(patch.toString('utf8'), /\+CHILD_TWO proposal/);
      const parentIndex = fs.readFileSync(path.join(root, '.git', 'index'));
      const worktrees = () =>
        execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
      const beforePreflight = worktrees();
      await assert.rejects(preflight([firstId, secondId], firstId), /不属于当前会话/);
      await assert.rejects(preflight([firstId, secondId], session.id, '  '), /测试命令/);
      const overlap = await preflight([firstId, secondId], session.id, 'exit 7');
      assert.equal(overlap.status, 'conflict', JSON.stringify(overlap));
      assert.deepEqual(overlap.conflictPaths, ['source.txt']);
      assert.equal(overlap.failedChildId, secondId);
      assert.deepEqual(overlap.checked, [firstId]);
      assert.equal(overlap.test, undefined);
      const secondFile = path.join(secondStatus.workspace, 'source.txt');
      const independent = path.join(secondStatus.workspace, 'independent.txt');
      fs.writeFileSync(secondFile, 'base');
      fs.writeFileSync(independent, 'unrelated proposal\n');
      try {
        const compatible = await preflight([firstId, secondId]);
        assert.equal(compatible.status, 'compatible', JSON.stringify(compatible));
        assert.equal(compatible.baseCommit, exported.baseCommit);
        assert.deepEqual(compatible.checked, [firstId, secondId]);
        assert.deepEqual(compatible.conflictPaths, []);
        assert.equal(compatible.test, undefined);
        assert.equal(fs.readFileSync(independent, 'utf8'), 'unrelated proposal\n');

        const outside = path.join(root, 'preflight-probe.txt');
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        const suite = [
          'test "$(cat source.txt)" = "CHILD_ONE proposal" || exit 21',
          'test "$(cat independent.txt)" = "unrelated proposal" || exit 22',
          'printf verified > "$TMPDIR/test-marker" || exit 23',
          `(printf forbidden > ${quote(outside)}) 2>/dev/null && exit 24`,
          'printf "%s\\n" "$PWD"',
        ].join('\n');
        const verified = await preflight([firstId, secondId], session.id, suite);
        assert.equal(verified.status, 'compatible');
        assert.equal(fs.existsSync(outside), false);
        if (verified.test.exitCode === undefined) {
          assert.equal(verified.test.isError, true);
          assert.match(verified.test.output, /缺少可用的 Shell 沙箱/);
          t.diagnostic('Verified that the preflight refuses to run without a shell sandbox.');
        } else {
          assert.equal(verified.test.exitCode, 0, verified.test.output);
          assert.equal(verified.test.isError, false);
          const testedWorktree = verified.test.output.trim();
          assert.match(path.dirname(testedWorktree), /bruin-patch-/);
          assert.equal(fs.existsSync(testedWorktree), false);

          const failed = await preflight([firstId, secondId], session.id, 'exit 7');
          assert.equal(failed.status, 'compatible');
          assert.equal(failed.test.isError, true);
          assert.equal(failed.test.exitCode, 7);
        }
      } finally {
        fs.writeFileSync(secondFile, 'CHILD_TWO proposal');
        fs.writeFileSync(independent, 'base independent\n');
      }
      assert.equal(worktrees(), beforePreflight);
      assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), parentIndex);
      assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'parent edit');
      const verify = path.join(dir, 'verify-patch');
      git(['worktree', 'add', '-q', '--detach', verify, exported.baseCommit]);
      execFileSync('git', ['apply', '--check', '-'], { cwd: verify, input: patch });
      execFileSync('git', ['apply', '-'], { cwd: verify, input: patch });
      assert.equal(fs.readFileSync(path.join(verify, 'source.txt'), 'utf8'), 'CHILD_TWO proposal');
      assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'parent edit');
      const seed = new SqliteEventStore(path.join(dir, 'home', 'sessions.sqlite'));
      let recoveredParent: string;
      try {
        const manualRun = seed.events(session.id);
        for (const id of [firstId, secondId]) {
          const spawned = manualRun.find(
            (event) => event.type === 'subagent_started' && event.payload.childId === id,
          );
          const launch = manualRun.find((event) => event.seq === spawned?.payload.toolStartedSeq);
          assert.equal(launch?.type, 'tool_started');
          assert.equal(launch.payload.name, 'spawn_subagent');
          assert.ok(
            manualRun.some(
              (event) =>
                event.type === 'tool_requested' &&
                event.payload.source === 'desktop' &&
                event.payload.callId === launch.payload.callId,
            ),
          );
        }
        const parent = seed.createSession(root, session.profile);
        const delegated = seed.createSession(root, session.profile);
        seed.append(parent.id, 'tool_requested', {
          callId: 'interrupted-spawn',
          name: 'spawn_subagent',
          input: { prompt: 'interrupted delegation' },
          source: 'desktop',
        });
        const launch = seed.append(parent.id, 'tool_started', {
          callId: 'interrupted-spawn',
          name: 'spawn_subagent',
        });
        seed.append(parent.id, 'subagent_started', {
          childId: delegated.id,
          prompt: 'interrupted delegation',
          workspace: root,
          mode: 'read-only',
          toolStartedSeq: launch.seq,
        });
        seed.append(delegated.id, 'user', { text: 'interrupted delegation' });
        seed.append(delegated.id, 'assistant', { text: 'recorded before interruption', calls: [] });
        seed.append(delegated.id, 'turn_completed', {});
        recoveredParent = parent.id;
      } finally {
        seed.close();
      }
      fs.writeFileSync(path.join(dir, 'fail-receipt'), 'fail');
      await assert.rejects(
        request('openSession', { sessionId: recoveredParent }),
        /injected recovery failure/,
      );
      const inspect = new SqliteEventStore(path.join(dir, 'home', 'sessions.sqlite'));
      try {
        assert.equal(inspect.isLeased(recoveredParent), false);
      } finally {
        inspect.close();
      }
      fs.unlinkSync(path.join(dir, 'fail-receipt'));
      for (let attempt = 0; attempt < 2; attempt++) {
        const opened = await request('openSession', { sessionId: recoveredParent });
        const launch = opened.events.filter(
          (event: any) =>
            event.type === 'tool_finished' && event.payload.callId === 'interrupted-spawn',
        );
        assert.equal(launch.length, 1);
        assert.equal(launch[0].payload.isError, false);
        const results = opened.events.filter((event: any) => event.type === 'subagent_finished');
        assert.equal(results.length, 1);
        assert.equal(results[0].payload.answer, 'recorded before interruption');
        assert.equal(results[0].payload.recovered, true);
      }
      assert.equal(
        fs.readFileSync(path.join(firstStatus.workspace, 'source.txt'), 'utf8'),
        'CHILD_ONE proposal',
      );
      assert.equal(
        fs.readFileSync(path.join(secondStatus.workspace, 'source.txt'), 'utf8'),
        'CHILD_TWO proposal',
      );
      fs.unlinkSync(path.join(dir, 'release'));
      await request('setApprovalMode', { mode: 'auto' });
      await request('send', {
        sessionId: session.id,
        prompt: 'PARENT_INVESTIGATE',
        maxModelCalls: 96,
        allowWorkspaceEdits: true,
      });
      await waitUntil(
        () =>
          fs.existsSync(path.join(dir, 'PARENT.ready')) &&
          fs.existsSync(path.join(dir, 'CHILD_THREE.ready')),
      );
      const receipt = await request('send', {
        sessionId: session.id,
        prompt: 'STOP_RESEARCH',
        delivery: 'steer',
      });
      assert.equal(receipt.queued, true);
      await waitUntil(() =>
        notifications.some(
          (message) => message.type === 'runFinished' || message.type === 'runFailed',
        ),
      );
      const failure = notifications.find((message) => message.type === 'runFailed');
      assert.equal(failure, undefined, failure?.message);
      const events = notifications.find((message) => message.type === 'runFinished').events;
      assert.equal(
        events.filter(
          (event: any) => event.type === 'user' && event.payload.text === 'STOP_RESEARCH',
        ).length,
        1,
      );
      const third = events.find(
        (event: any) => event.type === 'subagent_started' && event.payload.prompt === 'CHILD_THREE',
      );
      assert.ok(third);
      assert.ok(
        events.some(
          (event: any) =>
            event.type === 'subagent_finished' &&
            event.payload.childId === third.payload.childId &&
            event.payload.status === 'failed',
        ),
      );
      assert.equal(fs.existsSync(path.join(dir, 'release')), false);
      assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'parent edit');
    } finally {
      fs.writeFileSync(path.join(dir, 'release'), 'go');
      child.kill('SIGTERM');
      await exited;
      lines.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
