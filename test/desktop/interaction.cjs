// Run after npm run desktop:build with npx electron test/desktop/interaction.cjs.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, dialog } = require('electron');

const root = path.resolve(__dirname, '../..');
const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-desktop-interaction-')),
);
const home = path.join(scratch, 'bruin');
const frontend = path.join(scratch, 'frontend');
const backend = path.join(scratch, 'backend');
const node = process.env.BRUIN_NODE_BINARY ?? 'node';
process.env.BRUIN_HOME = home;
delete process.env.BRUIN_RENDERER_URL;
app.setPath('userData', path.join(scratch, 'electron'));
process.on('exit', () => {
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of temp scratch directory.
  }
});

async function waitFor(check, description) {
  for (let i = 0; i < 200; i++) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  throw new Error(`Timed out: ${description}`);
}

function writeProjects() {
  for (const dir of [home, frontend, backend]) fs.mkdirSync(dir);
  for (const [project, name] of [
    [frontend, 'Frontend'],
    [backend, 'Backend'],
  ]) {
    fs.writeFileSync(path.join(project, 'shared.txt'), `${name} original`);
    fs.writeFileSync(path.join(project, 'extra.txt'), `${name} extra`);
    fs.writeFileSync(path.join(project, `${name}.md`), `Attachment for ${name}`);
  }
}

async function run() {
  writeProjects();
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'test' }] }));
      return;
    }
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [
      { delta: { role: 'assistant', content: 'Test reply' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ]) {
      response.write(
        `data: ${JSON.stringify({
          id: 'test-reply',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test',
          choices: [{ index: 0, ...choice }],
        })}\n\n`,
      );
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  try {
    const sessions = JSON.parse(
      execFileSync(
        node,
        [
          '--input-type=module',
          '-e',
          `
        import fs from 'node:fs';
        import path from 'node:path';
        import { SqliteEventStore } from './dist/storage/event-store.js';
        const [home, frontend, backend, port] = process.argv.slice(1);
        const profile = {
          alias: 'test', provider: 'openai-compatible', model: 'test',
          baseUrl: 'http://127.0.0.1:' + port + '/v1',
        };
        fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profiles: [profile] }));
        const store = new SqliteEventStore(path.join(home, 'sessions.sqlite'));
        const sessions = [frontend, backend].map((workspace, index) => {
          const session = store.createSession(workspace, profile);
          store.append(session.id, 'assistant', { text: index ? 'Backend reference' : 'Frontend reference' });
          return session.id;
        });
        store.close();
        console.log(JSON.stringify(sessions));
      `,
          home,
          frontend,
          backend,
          String(server.address().port),
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    );

    // Supply file picker selections. All storage and RPC handlers are those of the app.
    let picked;
    dialog.showOpenDialog = async () => {
      assert.ok(picked, 'unexpected picker');
      const filePaths = [picked];
      picked = undefined;
      return { canceled: false, filePaths };
    };
    require(path.join(root, 'desktop/main.cjs'));
    const window = await waitFor(() => BrowserWindow.getAllWindows()[0], 'desktop window');
    const js = (code) => window.webContents.executeJavaScript(code, true);
    const selector = (value) => `document.querySelector(${JSON.stringify(value)})`;
    const click = async (value) => {
      await waitFor(() => js(`Boolean(${selector(value)})`), value);
      await js(`${selector(value)}.click()`);
    };
    const button = (text) =>
      `[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    const choose = async (text) => {
      await waitFor(() => js(`Boolean(${button(text)})`), text);
      await js(`${button(text)}.click()`);
      await waitFor(() => js('!document.querySelector("main[inert]")'), 'file operation done');
    };
    const editor = '.code-editor-textarea';
    const composer = '.composer textarea';
    const value = (target) => js(`${selector(target)}?.value`);
    const type = async (target, text) => {
      await js(`(() => {
        const field = ${selector(target)};
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)});
        field.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(() => js(`${selector(target)}.value === ${JSON.stringify(text)}`), text);
    };
    const close = (file) => click(`.editor-tab button[aria-label="关闭 ${file}"]`);
    const workspace = (dir) =>
      waitFor(
        () =>
          js(
            `document.querySelector('.workspace-switch')?.textContent.trim() === ${JSON.stringify(dir)} && !document.querySelector('main[inert]')`,
          ),
        dir,
      );
    const session = (index) => click(`.session-row:nth-child(${index + 1}) .session-item`);
    const rowFor = async (dir) => {
      return js(
        `[...document.querySelectorAll('.session-row')].findIndex(row => row.querySelector('small').textContent.trim().startsWith(${JSON.stringify(path.basename(dir) + ' ·')}))`,
      );
    };
    async function draft(text, attachment, reference) {
      assert.equal(await value(composer), text);
      const context = await js(
        `[...document.querySelectorAll('.composer-chip')].map(chip => chip.textContent.trim())`,
      );
      assert.deepEqual(context, reference ? [`引用：${reference}`, attachment] : []);
    }
    async function enterDraft(project, text, reference) {
      await waitFor(() => js(`Boolean(${selector(composer)})`), 'composer');
      await type(composer, text);
      await click('.quote-action');
      const attachment = `${path.basename(project) === 'frontend' ? 'Frontend' : 'Backend'}.md`;
      picked = path.join(project, attachment);
      await click('button[aria-label="添加文件"]');
      await waitFor(
        () => js(`Boolean(${selector(`button[aria-label="移除 ${attachment}"]`)})`),
        attachment,
      );
      await draft(text, attachment, reference);
    }
    const file = (name) => click(`.explorer-entry[title="${name}"]`);
    await waitFor(
      () => js('document.querySelectorAll(".session-row").length === 2'),
      'both sessions',
    );
    await waitFor(
      () => js('Boolean(document.querySelector(".session-item.active"))'),
      'initial session',
    );
    await session(await rowFor(frontend));
    await workspace(frontend);
    await click('.explorer-toggle');
    await file('shared.txt');
    await waitFor(() => js(`Boolean(${selector(editor)})`), 'editor');
    await type(editor, 'Frontend edit');
    await close('shared.txt');
    await choose('取消');
    assert.equal(await value(editor), 'Frontend edit');
    assert.equal(fs.readFileSync(path.join(frontend, 'shared.txt'), 'utf8'), 'Frontend original');

    picked = backend;
    await click('.workspace-switch');
    await choose('取消');
    await workspace(frontend);
    assert.equal(await value(editor), 'Frontend edit');
    await click('.new-task');
    await choose('取消');
    await workspace(frontend);
    assert.equal(await js('document.querySelectorAll(".session-row").length'), 2);
    assert.equal(await value(editor), 'Frontend edit');

    await file('extra.txt');
    await waitFor(() => value(editor).then((text) => text === 'Frontend extra'), 'second editor');
    await type(editor, 'Second edit');
    await session(await rowFor(backend));
    await waitFor(
      () => js('document.querySelectorAll("dialog[open] li").length === 2'),
      'both dirty files',
    );
    assert.deepEqual(
      await js(
        '[...document.querySelectorAll("dialog[open] li")].map(li => li.textContent).sort()',
      ),
      ['extra.txt', 'shared.txt'],
    );
    await choose('取消');
    await workspace(frontend);
    assert.equal(await value(editor), 'Second edit');

    await close('extra.txt');
    await choose('保存并继续');
    assert.equal(fs.readFileSync(path.join(frontend, 'extra.txt'), 'utf8'), 'Second edit');
    await click('.editor-tab button[title="shared.txt"]');
    fs.writeFileSync(path.join(frontend, 'shared.txt'), 'External edit');
    await close('shared.txt');
    await choose('保存并继续');
    await waitFor(() => js('Boolean(document.querySelector(".toast.error"))'), 'save conflict');
    assert.equal(await value(editor), 'Frontend edit');
    assert.equal(fs.readFileSync(path.join(frontend, 'shared.txt'), 'utf8'), 'External edit');
    await close('shared.txt');
    await choose('放弃修改');
    assert.equal(await value(editor), undefined);
    assert.equal(fs.readFileSync(path.join(frontend, 'shared.txt'), 'utf8'), 'External edit');
    await file('shared.txt');
    await waitFor(() => value(editor).then((text) => text === 'External edit'), 'clean file');
    await close('shared.txt');
    await waitFor(() => js(`Boolean(${selector(composer)})`), 'clean file closed directly');
    assert.equal(await js('Boolean(document.querySelector("dialog[open]"))'), false);

    await enterDraft(frontend, 'Frontend draft', 'Frontend reference');
    await session(await rowFor(backend));
    await workspace(backend);
    await draft('');
    await enterDraft(backend, 'Backend draft', 'Backend reference');
    await session(await rowFor(frontend));
    await workspace(frontend);
    await draft('Frontend draft', 'Frontend.md', 'Frontend reference');
    const budget = '.long-run-controls select';
    await js(`(() => {
      const select = ${selector(budget)};
      select.value = '96';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    picked = backend;
    await click('.workspace-switch');
    await workspace(backend);
    await draft('');
    assert.equal(await value(budget), '96');
    await type(composer, 'Same session, other project');
    picked = frontend;
    await click('.workspace-switch');
    await workspace(frontend);
    await draft('Frontend draft', 'Frontend.md', 'Frontend reference');
    picked = backend;
    await click('.workspace-switch');
    await workspace(backend);
    await draft('Same session, other project');
    picked = frontend;
    await click('.workspace-switch');
    await workspace(frontend);
    await draft('Frontend draft', 'Frontend.md', 'Frontend reference');

    async function send(index, text, reference, attachment) {
      await click('.send-button:not(.stop)');
      const sent = await waitFor(async () => {
        const result = await js(
          `window.bruin.request('openSession', { sessionId: ${JSON.stringify(sessions[index])} })`,
        );
        return result.events.find((event) => event.type === 'user' && event.payload.text === text);
      }, text);
      assert.equal(sent.payload.quote.text, reference);
      assert.deepEqual(
        sent.payload.attachments.map((item) => item.name),
        [attachment],
      );
      await waitFor(() => js('!document.querySelector(".send-button.stop")'), 'run finished');
      await draft('');
    }
    await send(0, 'Frontend draft', 'Frontend reference', 'Frontend.md');
    await session(await rowFor(backend));
    await workspace(backend);
    await draft('Backend draft', 'Backend.md', 'Backend reference');
    await send(1, 'Backend draft', 'Backend reference', 'Backend.md');

    await file('shared.txt');
    await waitFor(() => js(`Boolean(${selector(editor)})`), 'backend editor');
    await type(editor, 'Backend window-close edit');
    window.close();
    await choose('取消');
    assert.equal(await value(editor), 'Backend window-close edit');
    window.close();
    await waitFor(() => js(`Boolean(${button('保存并继续')})`), 'native close dialog');
    await js(`${button('保存并继续')}.click()`).catch((error) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) throw error;
    });
    await waitFor(() => window.isDestroyed(), 'window closed after save');
    assert.equal(
      fs.readFileSync(path.join(backend, 'shared.txt'), 'utf8'),
      'Backend window-close edit',
    );
    console.log(
      'Desktop interaction passed for frontend and backend (real files, IPC and sessions).',
    );
  } finally {
    server.close();
  }
}

run().then(
  () => app.quit(),
  (error) => {
    console.error(error);
    process.exitCode = 1;
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.quit();
    setTimeout(() => app.exit(1), 5000).unref();
  },
);
