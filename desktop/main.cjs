const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerSaveBlocker,
  safeStorage,
  shell,
} = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

let window;
let host;
const pending = new Map();
const development = Boolean(process.env.BRUIN_RENDERER_URL);
const iconThemes = new Set(['white', 'black', 'sage', 'blue', 'orange']);
let iconBackground = 'white';
let uiTheme = 'light';
let hostReady = Promise.resolve();
let longRunPowerBlocker;
const longRunSessions = new Set();
let startupWarnings = [];
let quitting = false;

function sendToWindow(message) {
  if (window && !window.isDestroyed()) window.webContents.send('bruin:event', message);
}

function flushStartupWarnings() {
  if (!startupWarnings.length || !window || window.isDestroyed()) return;
  const text = startupWarnings.join('；');
  startupWarnings = [];
  sendToWindow({ type: 'notice', message: text });
}

function stopLongRunPowerBlocker() {
  longRunSessions.clear();
  if (longRunPowerBlocker !== undefined && powerSaveBlocker.isStarted(longRunPowerBlocker))
    powerSaveBlocker.stop(longRunPowerBlocker);
  longRunPowerBlocker = undefined;
}

function secretsPath() {
  return path.join(
    process.env.BRUIN_HOME || path.join(app.getPath('home'), '.bruin'),
    'keys.enc.json',
  );
}
function secureStorageAvailable() {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  );
}
function readEncryptedKeys(file = secretsPath()) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.assign(Object.create(null), value)
      : Object.create(null);
  } catch (error) {
    if (error.code === 'ENOENT') return Object.create(null);
    throw new Error('已保存的密钥文件损坏或不可读取');
  }
}
function writeEncryptedKeys(keys, file = secretsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(keys), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function withSecretsLock(fn, file = secretsPath()) {
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const start = Date.now();
  const timeoutMs = 5000;
  let fd = null;
  let myLockToken = '';

  while (Date.now() - start < timeoutMs) {
    try {
      fd = fs.openSync(
        lockFile,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
        0o600,
      );
      myLockToken = `${process.pid}\n${Date.now()}`;
      try {
        fs.writeSync(fd, myLockToken);
      } catch (writeErr) {
        try {
          fs.closeSync(fd);
        } catch {}
        fd = null;
        try {
          fs.unlinkSync(lockFile);
        } catch {}
        throw writeErr;
      }
      break;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockFile);
          const content = fs.readFileSync(lockFile, 'utf8');
          const [pidStr, timestampStr] = content.split('\n');
          const pid = parseInt(pidStr, 10);
          const timestamp = parseInt(timestampStr, 10);
          let isAlive = false;
          if (Number.isFinite(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
              isAlive = true;
            } catch (e) {
              if (e.code === 'ESRCH') isAlive = false;
              else isAlive = true;
            }
          }
          const validPid = Number.isFinite(pid) && pid > 0;
          const isExpired =
            Date.now() - (Number.isFinite(timestamp) ? timestamp : stat.mtimeMs) > 10000;
          if ((validPid && !isAlive) || (!validPid && isExpired)) {
            try {
              const currentStat = fs.statSync(lockFile);
              const currentContent = fs.readFileSync(lockFile, 'utf8');
              const sameInode =
                process.platform !== 'win32' && stat.ino !== 0
                  ? currentStat.ino === stat.ino
                  : true;
              if (sameInode && currentContent === content && currentStat.mtimeMs === stat.mtimeMs) {
                fs.unlinkSync(lockFile);
              }
            } catch {}
            continue;
          }
        } catch {}
        const wait = 20 + Math.floor(Math.random() * 30);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      } else {
        throw err;
      }
    }
  }

  if (fd === null) {
    throw new Error('获取密钥文件锁超时，可能存在并发写入冲突');
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      const currentContent = fs.readFileSync(lockFile, 'utf8');
      if (currentContent === myLockToken) {
        fs.unlinkSync(lockFile);
      }
    } catch {}
  }
}
function updateStoredKey(alias, ciphertext, remove, file = secretsPath()) {
  return withSecretsLock(() => {
    const keys = readEncryptedKeys(file);
    if (remove) delete keys[alias];
    else if (ciphertext) keys[alias] = ciphertext;
    writeEncryptedKeys(keys, file);
  }, file);
}
const oauthSaveErrors = new Map();
function oauthPath() {
  return path.join(path.dirname(secretsPath()), 'oauth.enc.json');
}
async function restoreStoredOAuth() {
  const saved = readEncryptedKeys(oauthPath());
  if (!Object.keys(saved).length) return;
  if (!secureStorageAvailable()) throw new Error('系统安全存储不可用，无法恢复 OAuth 登录');
  let failed = 0;
  for (const [name, ciphertext] of Object.entries(saved)) {
    if (typeof ciphertext !== 'string') {
      failed++;
      continue;
    }
    try {
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(ciphertext, 'base64')));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        failed++;
        continue;
      }
      await requestHost('restoreMcpCredentials', { name, ...value });
    } catch {
      failed++;
    }
  }
  if (failed > 0)
    startupWarnings.push(
      `有 ${failed} 项已保存的 OAuth 凭证无法恢复，相关 MCP 服务器可能需要重新登录`,
    );
}
async function restoreStoredKeys() {
  const legacy = await requestHost('takeLegacyKeys');
  if (Object.keys(legacy).length && secureStorageAvailable()) {
    withSecretsLock(() => {
      const keys = readEncryptedKeys();
      let changed = false;
      for (const [alias, key] of Object.entries(legacy)) {
        if (typeof key !== 'string' || keys[alias]) continue;
        keys[alias] = safeStorage.encryptString(key).toString('base64');
        changed = true;
      }
      if (changed) writeEncryptedKeys(keys);
    });
  }
  const keys = readEncryptedKeys();
  if (!Object.keys(keys).length) return;
  if (!secureStorageAvailable()) throw new Error('系统安全存储不可用，无法恢复 API Key');
  const restored = {};
  let failed = 0;
  for (const [alias, ciphertext] of Object.entries(keys)) {
    if (typeof ciphertext !== 'string') {
      failed++;
      continue;
    }
    try {
      restored[alias] = safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
    } catch {
      failed++;
    }
  }
  if (Object.keys(restored).length) await requestHost('restoreApiKeys', { keys: restored });
  if (failed > 0)
    startupWarnings.push(`有 ${failed} 项已保存的 API Key 无法解密恢复，请在模型设置中重新填写`);
}

function appearancePath() {
  return path.join(
    process.env.BRUIN_HOME || path.join(app.getPath('home'), '.bruin'),
    'appearance.json',
  );
}
function iconPath(theme) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icons', `icon-${theme}.png`)
    : path.join(__dirname, 'assets', `icon-${theme}.png`);
}
function loadAppearance() {
  try {
    const stored = JSON.parse(fs.readFileSync(appearancePath(), 'utf8'));
    if (iconThemes.has(stored.iconBackground)) iconBackground = stored.iconBackground;
    if (stored.uiTheme === 'light' || stored.uiTheme === 'dark') uiTheme = stored.uiTheme;
  } catch {
    /* Keep the white default for a missing or invalid settings file. */
  }
}
function applyIcon() {
  const icon = iconPath(iconBackground);
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(icon);
  if (window && !window.isDestroyed() && process.platform !== 'darwin') window.setIcon(icon);
}
function saveAppearance(next) {
  let nextIconBackground = iconBackground;
  let nextUiTheme = uiTheme;
  if (next.iconBackground !== undefined) {
    if (!iconThemes.has(next.iconBackground)) throw new Error('不支持的图标背景颜色');
    nextIconBackground = next.iconBackground;
  }
  if (next.uiTheme !== undefined) {
    if (next.uiTheme !== 'light' && next.uiTheme !== 'dark') throw new Error('不支持的界面主题');
    nextUiTheme = next.uiTheme;
  }
  const file = appearancePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temp,
      JSON.stringify({ iconBackground: nextIconBackground, uiTheme: nextUiTheme }),
      { mode: 0o600 },
    );
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  iconBackground = nextIconBackground;
  uiTheme = nextUiTheme;
  applyIcon();
  if (window && !window.isDestroyed())
    window.setBackgroundColor(uiTheme === 'light' ? '#FFFFFF' : '#111315');
  return { iconBackground, uiTheme };
}

function startHost() {
  const runtime = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.resolve(__dirname, '..');
  const node = app.isPackaged
    ? path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node')
    : process.env.BRUIN_NODE_BINARY || 'node';
  const script = path.join(runtime, 'dist', 'desktop-host.js');
  host = spawn(node, [script], {
    cwd: runtime,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  readline.createInterface({ input: host.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    } else {
      if (message.type === 'oauthCredentials') {
        try {
          if (message.state && !secureStorageAvailable()) throw new Error('系统安全存储不可用');
          const ciphertext = message.state
            ? safeStorage
                .encryptString(
                  JSON.stringify({
                    signature: message.signature,
                    state: message.state,
                  }),
                )
                .toString('base64')
            : undefined;
          updateStoredKey(message.name, ciphertext, !message.state, oauthPath());
          oauthSaveErrors.delete(message.name);
        } catch {
          oauthSaveErrors.set(message.name, true);
          sendToWindow({
            type: 'notice',
            message: 'OAuth 凭证保存失败，重启后可能需要重新登录。',
          });
        }
        return;
      }
      if (message.type === 'openOAuthBrowser') {
        try {
          const url = new URL(message.url);
          if (
            url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
          )
            void shell.openExternal(url.href).catch(() => {});
        } catch {
          sendToWindow({ type: 'notice', message: '无效的 OAuth 授权地址' });
        }
        return;
      }
      if (message.type === 'runStarted' && message.longRun && message.sessionId) {
        longRunSessions.add(message.sessionId);
        if (longRunPowerBlocker === undefined)
          longRunPowerBlocker = powerSaveBlocker.start('prevent-app-suspension');
      }
      if (message.type === 'runFinished' || message.type === 'runFailed') {
        if (message.sessionId) longRunSessions.delete(message.sessionId);
        if (!longRunSessions.size) stopLongRunPowerBlocker();
      }
      sendToWindow(message);
    }
  });
  host.stderr.on('data', (data) => {
    if (development) process.stderr.write(data);
  });
  host.stdin.on('error', () => {
    /* Handled by host exit/error events. */
  });
  host.on('error', (error) => {
    stopLongRunPowerBlocker();
    for (const entry of pending.values())
      entry.reject(new Error(`Agent 后台进程启动失败: ${error.message}`));
    pending.clear();
    sendToWindow({ type: 'hostExited', code: null, signal: null });
  });
  host.on('exit', (code, signal) => {
    stopLongRunPowerBlocker();
    for (const entry of pending.values()) entry.reject(new Error('Agent 后台进程已退出'));
    pending.clear();
    sendToWindow({ type: 'hostExited', code, signal });
  });
}

function requestHost(method, params) {
  if (!host || !host.stdin.writable) return Promise.reject(new Error('Agent 后台进程不可用'));
  const id = randomUUID();
  let line;
  try {
    line = JSON.stringify({ id, method, params }) + '\n';
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.stdin.write(line, (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
  });
}

async function exportSubagentPatch(params) {
  await hostReady;
  const { baseCommit, contentBase64 } = await requestHost('prepareSubagentPatch', {
    sessionId: params?.sessionId,
    childId: params?.childId,
  });
  const shortId = String(params?.childId)
    .slice(0, 8)
    .replace(/[^a-f0-9]/gi, '');
  if (!window || window.isDestroyed()) return null;
  const selected = await dialog.showSaveDialog(window, {
    title: '导出子任务补丁',
    defaultPath: `bruin-${shortId}-${baseCommit.slice(0, 12)}.patch`,
    filters: [{ name: 'Git 补丁', extensions: ['patch'] }],
  });
  if (selected.canceled || !selected.filePath) return null;
  const temporary = await fs.promises.mkdtemp(
    path.join(path.dirname(selected.filePath), '.bruin-patch-'),
  );
  try {
    const file = path.join(temporary, 'proposal.patch');
    await fs.promises.writeFile(file, Buffer.from(contentBase64, 'base64'), { mode: 0o600 });
    await fs.promises.copyFile(file, selected.filePath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('目标文件已存在，请选择新的文件名');
    throw error;
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
  return { path: selected.filePath, baseCommit };
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 650,
    title: 'Bruin',
    backgroundColor: uiTheme === 'light' ? '#FFFFFF' : '#111315',
    icon: iconPath(iconBackground),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') void shell.openExternal(parsed.href).catch(() => {});
    } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => {
    window = undefined;
  });
  if (development) void window.loadURL(process.env.BRUIN_RENDERER_URL);
  else void window.loadFile(path.join(__dirname, 'build', 'renderer', 'index.html'));
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(() => {
    loadAppearance();
    startHost();
    hostReady = restoreStoredKeys()
      .catch((error) => {
        startupWarnings.push(error instanceof Error ? error.message : String(error));
      })
      .then(() =>
        restoreStoredOAuth().catch((error) => {
          startupWarnings.push(error instanceof Error ? error.message : String(error));
        }),
      );
    createWindow();
    applyIcon();
    ipcMain.handle('bruin:request', async (event, method, params) => {
      if (
        !window ||
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('无效的界面请求');
      if (typeof method !== 'string' || !method) throw new Error('无效的请求方法');
      if (
        params !== undefined &&
        (params === null || typeof params !== 'object' || Array.isArray(params))
      )
        throw new Error('无效的请求参数');
      if (method === 'chooseWorkspace')
        return dialog
          .showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
          .then((result) => (result.canceled ? null : result.filePaths[0]));
      if (method === 'exportSubagentPatch') return exportSubagentPatch(params);
      if (method === 'preflightSubagentPatches' && params?.testCommand !== undefined) {
        const { sessionId, childIds, testCommand } = params;
        if (typeof testCommand !== 'string' || !testCommand.trim() || testCommand.length > 10_000)
          throw new Error('测试命令须为 1 至 10,000 字符的非空文本');
        const { response } = await dialog.showMessageBox(window, {
          type: 'warning',
          buttons: ['取消', '运行测试'],
          defaultId: 0,
          cancelId: 0,
          message: '在临时工作树中运行这条命令？',
          detail: `补丁全部应用后，命令将在临时仓库根目录的 Shell 沙箱中运行。\n\n${testCommand}`,
        });
        if (response !== 1) return null;
        await hostReady;
        return requestHost(method, { sessionId, childIds, testCommand });
      }
      if (method === 'chooseAttachments') {
        const selection = await dialog.showOpenDialog(window, {
          properties:
            params?.kind === 'folder'
              ? ['openDirectory', 'multiSelections']
              : ['openFile', 'multiSelections'],
        });
        if (selection.canceled) return [];
        await hostReady;
        return requestHost('importAttachments', {
          sessionId: params?.sessionId,
          paths: selection.filePaths,
        });
      }
      if (method === 'getAppearance') return { iconBackground, uiTheme };
      if (method === 'setIconBackground') return saveAppearance({ iconBackground: params?.theme });
      if (method === 'setTheme') return saveAppearance({ uiTheme: params?.theme });
      if (
        method === 'restoreApiKeys' ||
        method === 'takeLegacyKeys' ||
        method === 'restoreMcpCredentials' ||
        method === 'importAttachments' ||
        method === 'prepareSubagentPatch'
      )
        throw new Error('不支持此界面操作');
      await hostReady;
      if (method === 'bootstrap') flushStartupWarnings();
      if (method === 'loginMcpServer' && !secureStorageAvailable())
        throw new Error('系统安全存储不可用，无法持久保存 OAuth 凭证');
      const apiKey =
        typeof params?.apiKey === 'string' && params.apiKey ? params.apiKey : undefined;
      if (method === 'saveProfile' && apiKey && !secureStorageAvailable())
        throw new Error('系统安全存储不可用，无法持久保存 API Key');
      const alias = String(params?.alias ?? '').trim();
      const encryptedKey =
        method === 'saveProfile' && apiKey
          ? safeStorage.encryptString(apiKey).toString('base64')
          : undefined;
      const previousProfile =
        method === 'saveProfile'
          ? (await requestHost('bootstrap')).config.profiles.find((item) => item.alias === alias)
          : null;
      const result = await requestHost(method, params || {});
      if (
        ['loginMcpServer', 'logoutMcpServer', 'removeMcpServer', 'saveMcpServer'].includes(
          method,
        ) &&
        oauthSaveErrors.has(params?.name)
      )
        throw new Error('OAuth 凭证保存或清除失败，请检查本机安全存储');
      if (method === 'saveProfile') {
        const removeKey = Boolean(
          params?.clearApiKey ||
          (previousProfile && previousProfile.provider !== params?.provider && !apiKey),
        );
        if (apiKey || removeKey) updateStoredKey(alias, encryptedKey, removeKey);
      }
      if (method === 'removeProfile' && alias) updateStoredKey(alias, undefined, true);
      return result;
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('will-quit', (event) => {
    stopLongRunPowerBlocker();
    const alive = host && host.exitCode === null && host.signalCode === null;
    if (!alive || quitting) return;
    quitting = true;
    event.preventDefault();
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      app.quit();
    };
    host.once('exit', done);
    host.stdin.end();
    const termTimer = setTimeout(() => {
      if (host && host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
    }, 5000);
    const killTimer = setTimeout(() => {
      if (host && host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
      done();
    }, 15000);
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
