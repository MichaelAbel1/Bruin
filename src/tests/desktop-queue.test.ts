import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pendingInputs } from '../core/input-queue.js';

// Intercept only the model transport. Host RPC, attachment loading, SDK stream
// parsing, event persistence and queue scheduling run normally, without sockets.
const provider = `
import fs from 'node:fs';
let calls = 0;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'http://localhost:9999/v1/chat/completions') throw new Error('Unexpected provider URL');
  const body = JSON.parse(init.body);
  fs.appendFileSync(process.env.BRUIN_TEST_TRACE, JSON.stringify(body) + '\\n');
  if (++calls === 1) {
    fs.writeFileSync(process.env.BRUIN_TEST_READY, 'ready');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(process.env.BRUIN_TEST_RELEASE)) {
      if (Date.now() > deadline) throw new Error('Mock provider was not released');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
    id: 'reply-' + calls, object: 'chat.completion.chunk', created: 1, model: 'mock',
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\\n\\n';
  return new Response(chunk({ role: 'assistant', content: 'Image received ' + calls }, null) +
    chunk({}, 'stop') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
};
`;

test(
  'desktop RPC queues image inputs, rejects cross-session delivery and settles once',
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
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready)) {
        assert.ok(Date.now() < deadline, stderr || 'Provider did not start');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
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
    } finally {
      clearTimeout(deadlineTimer);
      fs.writeFileSync(release, 'go');
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
