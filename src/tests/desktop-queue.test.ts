import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pendingInputs } from '../core/input-queue.js';
import { pendingQuestion, recordQuestionAnswer } from '../core/question.js';
import { canResumeTurn, turnState } from '../core/turn-state.js';
import { SqliteEventStore } from '../storage/event-store.js';

// Stub the model transport and hold one hook open. Host RPC, SDK stream parsing,
// attachment loading and the durable queue run normally.
const provider = `
import fs from 'node:fs';
import { ProcessExecutor } from ${JSON.stringify(new URL('../executor/client.js', import.meta.url).href)};
let calls = 0;
async function waitForRelease(suffix) {
  fs.writeFileSync(process.env.BRUIN_TEST_READY + suffix, 'ready');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(process.env.BRUIN_TEST_RELEASE + suffix)) {
    if (Date.now() > deadline) throw new Error('Test gate was not released');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const execute = ProcessExecutor.prototype.execute;
ProcessExecutor.prototype.execute = async function(request, signal) {
  if (request.input.command !== 'verify after the turn') return execute.call(this, request, signal);
  await waitForRelease('-hook');
  return { output: 'verified', isError: false };
};
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'http://localhost:9999/v1/chat/completions') throw new Error('Unexpected provider URL');
  const body = JSON.parse(init.body);
  fs.appendFileSync(process.env.BRUIN_TEST_TRACE, JSON.stringify(body) + '\\n');
  if (++calls === 1) await waitForRelease('');
  const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
    id: 'reply-' + calls, object: 'chat.completion.chunk', created: 1, model: 'mock',
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\\n\\n';
  const user = JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1));
  const tool = (index, id, name, input) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
  const response = (data) => new Response(data + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
  if (user.includes('REQUEST_COMPATIBILITY')) {
    if (!body.tools?.some(tool => tool.function.name === 'ask_user')) throw new Error('question tool missing');
    return response(chunk({ role: 'assistant', tool_calls: [
      tool(0, 'question', 'ask_user', { question: 'Which legacy version must be supported?' }),
      tool(1, 'write-before-answer', 'write_file', { path: 'premature.txt', content: 'premature' }),
    ] }, null) + chunk({}, 'tool_calls'));
  }
  if (user.includes('ANSWER_')) {
    if (!user.includes('Which legacy version must be supported?')) throw new Error('question missing from answer context');
    if (!body.messages.some(message => message.tool_call_id === 'write-after-answer'))
      return response(chunk({ role: 'assistant', tool_calls: [
        tool(0, 'write-after-answer', 'write_file', { path: 'after.txt', content: 'requires approval' }),
      ] }, null) + chunk({}, 'tool_calls'));
  }
  return new Response(chunk({ role: 'assistant', content: 'Image received ' + calls }, null) +
    chunk({}, 'stop') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
};
`;

test(
  'desktop RPC queues image inputs and resumes a message received during the finishing hook',
  { timeout: 15000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-desktop-queue-'));
    const preloader = path.join(dir, 'provider.mjs');
    const ready = path.join(dir, 'ready');
    const release = path.join(dir, 'release');
    const trace = path.join(dir, 'requests.jsonl');
    fs.writeFileSync(preloader, provider);
    const image = path.join(dir, 'pixel.png');
    fs.writeFileSync(
      image,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const child = spawn(
      process.execPath,
      ['--import', preloader, fileURLToPath(new URL('../desktop-host.js', import.meta.url))],
      {
        env: {
          ...process.env,
          BRUIN_HOME: path.join(dir, 'home'),
          BRUIN_TEST_TRACE: trace,
          BRUIN_TEST_READY: ready,
          BRUIN_TEST_RELEASE: release,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const waiting = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
    let nextId = 0;
    let stderr = '';
    let queueUpdates = 0;
    let completions = 0;
    let latestEvents: any[] = [];
    let finish: (events: any[]) => void;
    let fail: (error: Error) => void;
    const done = new Promise<any[]>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Keep rejection observed if setup fails before awaiting completion.
    void done.catch(() => {});
    const failPending = (error: Error) => {
      for (const pending of waiting.values()) pending.reject(error);
      waiting.clear();
      fail(error);
    };
    const deadlineTimer = setTimeout(
      () => failPending(new Error(stderr || 'Desktop RPC timed out')),
      10000,
    );
    child.stderr.on('data', (data) => {
      stderr = (stderr + String(data)).slice(-10000);
    });
    child.on('error', failPending);
    child.on('exit', () => failPending(new Error(stderr || 'Desktop host exited')));
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id && waiting.has(message.id)) {
        const pending = waiting.get(message.id)!;
        waiting.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      }
      if (message.type === 'queueUpdated') queueUpdates++;
      if (message.type === 'runFinished') {
        completions++;
        latestEvents = message.events;
        finish(message.events);
      }
      if (message.type === 'runFailed' || message.type === 'approval')
        fail(new Error(message.message ?? 'Unexpected approval'));
    });
    const request = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    };
    const waitUntil = async (ready: () => boolean, description: string) => {
      const deadline = Date.now() + 5000;
      while (!ready()) {
        assert.ok(Date.now() < deadline, stderr || description);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    try {
      await request('saveProfile', {
        alias: 'local',
        provider: 'openai-compatible',
        model: 'mock',
        baseUrl: 'http://localhost:9999/v1',
      });
      const { session } = await request('createSession', { workspace: dir, profileAlias: 'local' });
      const other = await request('createSession', { workspace: dir, profileAlias: 'local' });
      const attachments = await request('importAttachments', {
        sessionId: session.id,
        paths: [image],
      });
      assert.equal(
        (await request('send', { sessionId: session.id, prompt: 'INITIAL_REQUEST' })).started,
        true,
      );
      await waitUntil(() => fs.existsSync(ready), 'Provider did not start');
      await assert.rejects(
        request('send', { sessionId: other.session.id, prompt: 'other', delivery: 'steer' }),
        /其他会话/,
      );
      for (const prompt of ['FIRST_QUEUED_IMAGE', 'SECOND_QUEUED_IMAGE']) {
        const receipt = await request('send', {
          sessionId: session.id,
          prompt,
          delivery: 'steer',
          attachments: attachments.map((ref: { id: string }) => ref.id),
        });
        assert.equal(receipt.queued, true);
      }
      fs.writeFileSync(release, 'go');
      const events = await done;
      assert.equal(completions, 1);
      assert.equal(queueUpdates, 2);
      assert.equal(pendingInputs(events).length, 0);
      assert.equal(events.filter((event) => event.type === 'user').length, 3);
      assert.equal(events.filter((event) => event.type === 'turn_completed').length, 1);
      const requests = fs
        .readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(requests.length, 3);
      for (const [index, label] of [
        [1, 'FIRST_QUEUED_IMAGE'],
        [2, 'SECOND_QUEUED_IMAGE'],
      ] as const) {
        const latest = requests[index].messages
          .filter((m: { role: string }) => m.role === 'user')
          .at(-1);
        assert.match(JSON.stringify(latest), new RegExp(label));
        assert.equal(
          latest.content.filter((part: { type: string }) => part.type === 'image_url').length,
          1,
        );
      }
      assert.doesNotMatch(JSON.stringify(requests[1]), /SECOND_QUEUED_IMAGE/);

      await request('saveHook', {
        name: 'verify',
        event: 'turn_finished',
        command: 'verify after the turn',
        enabled: true,
      });
      await request('send', { sessionId: session.id, prompt: 'FINISH_BEFORE_QUEUED' });
      await waitUntil(() => fs.existsSync(ready + '-hook'), 'Finishing hook did not start');
      const late = await request('send', {
        sessionId: session.id,
        prompt: 'FOLLOW_UP_AFTER_HOOK',
        delivery: 'follow-up',
      });
      assert.equal(late.queued, true);
      fs.writeFileSync(release + '-hook', 'go');
      await waitUntil(() => completions === 2, 'First turn did not finish');
      assert.equal(turnState(latestEvents), 'completed');
      assert.equal(canResumeTurn(latestEvents), true);
      assert.equal(pendingInputs(latestEvents).length, 1);

      assert.equal((await request('resume', { sessionId: session.id })).started, true);
      await waitUntil(() => completions === 3, 'Queued follow-up did not finish');
      const latestRequests = fs
        .readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(latestRequests.length, 5);
      assert.match(
        JSON.stringify(
          latestRequests[4].messages.filter((m: { role: string }) => m.role === 'user').at(-1),
        ),
        /FOLLOW_UP_AFTER_HOOK/,
      );
      assert.equal(pendingInputs(latestEvents).length, 0);
      assert.equal(canResumeTurn(latestEvents), false);
      assert.equal(latestEvents.filter((event) => event.type === 'hook_finished').length, 2);

      const cli = (sessionId: string, ...args: string[]) => {
        const child = promisify(execFile)(
          process.execPath,
          [
            '--import',
            preloader,
            fileURLToPath(new URL('../cli.js', import.meta.url)),
            'chat',
            '--resume',
            sessionId,
            ...args,
          ],
          {
            cwd: dir,
            env: {
              ...process.env,
              BRUIN_HOME: path.join(dir, 'home'),
              BRUIN_TEST_TRACE: trace,
              BRUIN_TEST_READY: ready,
              BRUIN_TEST_RELEASE: release,
            },
            timeout: 5_000,
          },
        );
        child.child.stdin?.end();
        return child;
      };

      await request('send', { sessionId: session.id, prompt: 'REQUEST_COMPATIBILITY' });
      await waitUntil(() => completions === 4, 'The question did not pause the task');
      const question = pendingQuestion(latestEvents)!;
      assert.equal(question.text, 'Which legacy version must be supported?');
      assert.equal(canResumeTurn(latestEvents), false);
      assert.ok(
        latestEvents.some(
          (event) => event.type === 'tool_denied' && event.payload.callId === 'write-before-answer',
        ),
      );
      await assert.rejects(request('resume', { sessionId: session.id }), /待答问题/);
      await assert.rejects(
        cli(session.id),
        (error: Error & { code?: number; stdout?: string }) =>
          error.code === 2 && Boolean(error.stdout?.includes(question.id)),
      );
      await assert.rejects(
        request('answerQuestion', {
          sessionId: other.session.id,
          questionId: question.id,
          text: 'a different session',
        }),
        /不属于当前会话/,
      );

      const db = new SqliteEventStore(path.join(dir, 'home', 'sessions.sqlite'));
      try {
        const priorCompletions = db
          .events(session.id)
          .filter((event) => event.type === 'turn_completed').length;
        const competing = await Promise.allSettled([
          cli(session.id, '--answer', question.id, 'ANSWER_CLI'),
          request('answerQuestion', {
            sessionId: session.id,
            questionId: question.id,
            text: 'ANSWER_DESKTOP',
            unattended: true,
            maxModelCalls: 96,
          }),
        ]);
        assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
        await waitUntil(
          () =>
            db.events(session.id).filter((event) => event.type === 'turn_completed').length ===
              priorCompletions + 1 && !db.isLeased(session.id),
          'The accepted answer did not reach the model',
        );
        const afterAnswer = db.events(session.id);
        assert.equal(
          afterAnswer.filter(
            (event) => event.type === 'user' && event.payload.answerTo === question.id,
          ).length,
          1,
        );
        assert.ok(
          afterAnswer.some(
            (event) =>
              event.type === 'tool_denied' && event.payload.callId === 'write-after-answer',
          ),
        );
        assert.equal(fs.existsSync(path.join(dir, 'premature.txt')), false);
        assert.equal(fs.existsSync(path.join(dir, 'after.txt')), false);

        await request('send', { sessionId: other.session.id, prompt: 'REQUEST_COMPATIBILITY' });
        await waitUntil(
          () =>
            Boolean(pendingQuestion(db.events(other.session.id))) && !db.isLeased(other.session.id),
          'The second question did not persist',
        );
        const second = pendingQuestion(db.events(other.session.id))!;
        const unknown = db.append(other.session.id, 'tool_unknown', {
          callId: 'interrupted-mutation',
          name: 'write_file',
          output: 'fixture for an interrupted write',
        });
        await assert.rejects(
          request('answerQuestion', {
            sessionId: other.session.id,
            questionId: second.id,
            text: 'ANSWER_BLOCKED_BY_REVIEW',
          }),
          /执行结果未知/,
        );
        await assert.rejects(
          cli(other.session.id, '--answer', second.id, 'ANSWER_BLOCKED_BY_REVIEW'),
          {
            code: 3,
          },
        );
        assert.equal(pendingQuestion(db.events(other.session.id))?.id, second.id);
        await request('reviewUnknown', { sessionId: other.session.id, throughSeq: unknown.seq });
        db.acquireLease(other.session.id, 'interrupted-client', 30_000);
        try {
          recordQuestionAnswer(db, other.session.id, second.id, 'ANSWER_BEFORE_INTERRUPT');
        } finally {
          db.releaseLease(other.session.id, 'interrupted-client');
        }
        await cli(other.session.id);
        assert.equal(
          db
            .events(other.session.id)
            .filter((event) => event.type === 'user' && event.payload.answerTo === second.id)
            .length,
          1,
        );
        assert.equal(turnState(db.events(other.session.id)), 'completed');
      } finally {
        db.close();
      }
    } finally {
      clearTimeout(deadlineTimer);
      fs.writeFileSync(release, 'go');
      fs.writeFileSync(release + '-hook', 'go');
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        if (child.exitCode === null && child.signalCode === null)
          await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      } finally {
        clearTimeout(timer);
        lines.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
