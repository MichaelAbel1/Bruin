import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SqliteEventStore } from '../storage/event-store.js';
import type { MemoryReviewPreview } from '../core/memory-review.js';
import type { ModelProfile, ToolResult } from '../core/types.js';

const mockProvider = `
import fs from 'node:fs';
globalThis.fetch = async (url, options) => {
  if (String(url) !== 'http://localhost:9999/v1/chat/completions') throw new Error('Unexpected URL');
  const body = JSON.parse(options.body);
  fs.appendFileSync(process.env.BRUIN_REVIEW_TRACE, JSON.stringify(body) + '\\n');
  const reply = { id: 'mock-reply', created: 1, model: 'mock' };
  if (body.stream) {
    const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
      ...reply, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
    }) + '\\n\\n';
    return new Response(chunk({ role: 'assistant', content: 'Found the test command.' }, null) +
      chunk({}, 'stop') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
  }
  const source = JSON.parse(body.messages.at(-1).content);
  const user = source.evidence.find(item => item.kind === 'user');
  const shell = source.evidence.find(item => item.kind === 'shell');
  const candidates = [{
    key: 'migration-tests',
    content: 'Run ' + shell.text + ' for migration tests.',
    evidenceSeqs: [user.seq, shell.seq],
  }];
  if (shell.text.endsWith('old')) candidates.push({
    key: 'rejected-note', content: 'DO_NOT_RECALL', evidenceSeqs: [user.seq],
  });
  if (user.text.includes('INVALID_EVIDENCE')) candidates[0].evidenceSeqs = [999];
  return Response.json({
    ...reply, object: 'chat.completion',
    choices: [{ index: 0, finish_reason: 'stop', message: {
      role: 'assistant', content: JSON.stringify(candidates),
    } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
};`;

test(
  'desktop memory review confirms evidence-backed revisions and isolates recall by workspace',
  { timeout: 15000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-memory-review-'));
    const home = path.join(dir, 'home');
    const workspace = fs.realpathSync(fs.mkdirSync(path.join(dir, 'a'), { recursive: true })!);
    const otherWorkspace = fs.realpathSync(fs.mkdirSync(path.join(dir, 'b'), { recursive: true })!);
    const trace = path.join(dir, 'trace.jsonl');
    const preloader = path.join(dir, 'provider.mjs');
    fs.writeFileSync(preloader, mockProvider);
    const profile: ModelProfile = {
      alias: 'mock',
      model: 'mock',
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:9999/v1',
    };
    const store = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
    function recordTurn(sessionId: string, text: string, command: string) {
      const user = store.append(sessionId, 'user', { text });
      const request = store.append(sessionId, 'tool_requested', {
        name: 'shell',
        callId: 'test',
        input: { command },
      });
      const result = store.append(sessionId, 'tool_finished', {
        name: 'shell',
        callId: 'test',
        exitCode: 0,
        isError: false,
        output: 'RAW_TOOL_PAYLOAD',
      });
      store.append(sessionId, 'assistant', { text: 'UNVERIFIED_ASSISTANT_SUMMARY' });
      return {
        user: user.seq,
        request: request.seq,
        result: result.seq,
        endSeq: store.append(sessionId, 'turn_completed', {}).seq,
      };
    }
    const first = store.createSession(workspace, profile);
    const initial = recordTurn(
      first.id,
      'Run the migration tests with the old command.',
      'npm run migration:old',
    );
    const second = store.createSession(otherWorkspace, profile);
    const prior = recordTurn(
      second.id,
      'OTHER_WORKSPACE_HISTORY',
      'npm run migration:wrong-workspace',
    );
    store.setWorkspace(second.id, workspace);
    const changed = recordTurn(
      second.id,
      'Correction for migration tests. password=DO_NOT_TRANSMIT',
      'npm run migration:new',
    );
    const broken = recordTurn(second.id, 'INVALID_EVIDENCE', 'npm run migration:new');
    const recall = store.createSession(workspace, profile);
    const isolated = store.createSession(otherWorkspace, profile);

    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(preloader).href,
        fileURLToPath(new URL('../desktop-host.js', import.meta.url)),
      ],
      {
        env: { ...process.env, BRUIN_HOME: home, BRUIN_REVIEW_TRACE: trace, BRUIN_SERVICE: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stopped = once(child, 'close');
    let log = '';
    child.stderr.on('data', (data: Buffer) => {
      log += data.toString();
    });
    let nextId = 0;
    const requests = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let activeRun:
      { sessionId: string; resolve: () => void; reject: (error: Error) => void } | undefined;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      const request = requests.get(message.id);
      if (request) {
        requests.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      } else if (activeRun && message.sessionId === activeRun.sessionId) {
        if (message.type === 'runFinished') activeRun.resolve();
        if (message.type === 'runFailed') activeRun.reject(new Error(message.message));
      }
    });
    child.once('exit', () => {
      const error = new Error(`Desktop host exited. ${log}`);
      for (const request of requests.values()) request.reject(error);
      activeRun?.reject(error);
    });
    function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        requests.set(id, { resolve: (value) => resolve(value as T), reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    }
    const preview = (sessionId: string, endSeq: number) =>
      rpc<MemoryReviewPreview>('previewMemoryReview', { sessionId, endSeq });
    const confirm = (sessionId: string, reviewId: string, key = 'migration-tests') =>
      rpc<ToolResult>('confirmMemoryCandidate', { sessionId, reviewId, key });
    async function run(sessionId: string) {
      const finished = new Promise<void>((resolve, reject) => {
        activeRun = { sessionId, resolve, reject };
      });
      try {
        await Promise.all([
          rpc('send', { sessionId, prompt: 'Which command runs migration tests?' }),
          finished,
        ]);
      } finally {
        activeRun = undefined;
      }
    }

    try {
      const draft = await preview(first.id, initial.endSeq);
      assert.deepEqual(store.listMemory(workspace), []);
      assert.deepEqual(draft.candidates[0].evidence, [
        { seq: initial.user, kind: 'user', text: 'Run the migration tests with the old command.' },
        {
          seq: initial.result,
          kind: 'shell',
          commandSeq: initial.request,
          text: 'npm run migration:old',
          exitCode: 0,
          isError: false,
        },
      ]);
      await assert.rejects(confirm(isolated.id, draft.id), /已失效/);
      assert.equal((await confirm(first.id, draft.id)).isError, false);
      await rpc('discardMemoryReview', { sessionId: first.id, reviewId: draft.id });
      await assert.rejects(confirm(first.id, draft.id, 'rejected-note'), /已失效/);
      assert.equal(store.listMemory(workspace).length, 1);

      await assert.rejects(preview(second.id, prior.endSeq), /当前工作区/);
      await assert.rejects(preview(second.id, broken.endSeq), /证据/);
      const revision = await preview(second.id, changed.endSeq);
      assert.match(revision.candidates[0].previousContent!, /migration:old/);
      assert.match(JSON.stringify(revision), /password=\[REDACTED\]/);
      assert.doesNotMatch(JSON.stringify(revision), /DO_NOT_TRANSMIT/);
      store.saveMemory(workspace, 'migration-tests', 'Concurrent update');
      const conflict = await confirm(second.id, revision.id);
      assert.equal(conflict.isError, true);
      assert.match(conflict.output, /其他操作修改/);
      assert.equal(store.listMemory(workspace)[0].content, 'Concurrent update');

      const refreshed = await preview(second.id, changed.endSeq);
      assert.equal(refreshed.candidates[0].previousContent, 'Concurrent update');
      assert.equal((await confirm(second.id, refreshed.id)).isError, false);
      const saved = store.listMemory(workspace)[0].content;
      assert.match(saved, /migration:new/);
      assert.ok(saved.includes(`${second.id} · 事件 #${changed.user}、#${changed.result}`));
      const approval = store
        .events(second.id)
        .find((event) => event.type === 'tool_approved' && event.payload.name === 'save_memory');
      assert.equal(approval?.payload.reason, '用户从桌面界面直接执行');

      await run(recall.id);
      await run(isolated.id);
      const providerCalls = fs.readFileSync(trace, 'utf8');
      assert.doesNotMatch(
        providerCalls,
        /OTHER_WORKSPACE_HISTORY|DO_NOT_TRANSMIT|RAW_TOOL_PAYLOAD|UNVERIFIED_ASSISTANT_SUMMARY/,
      );
      const [same, different] = providerCalls
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((body) => body.stream);
      const samePrompt = same.messages.find(
        (message: { role: string }) => message.role === 'system',
      ).content;
      const otherPrompt = different.messages.find(
        (message: { role: string }) => message.role === 'system',
      ).content;
      assert.match(samePrompt, /migration:new/);
      assert.doesNotMatch(samePrompt, /migration:old|DO_NOT_RECALL/);
      assert.doesNotMatch(otherPrompt, /migration:new|migration-tests|DO_NOT_RECALL/);
      assert.deepEqual(store.listMemory(otherWorkspace), []);
    } finally {
      lines.close();
      child.stdin.end();
      child.kill();
      await stopped;
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
