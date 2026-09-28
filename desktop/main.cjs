const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
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
function readEncryptedKeys() {
  try {
    const value = JSON.parse(fs.readFileSync(secretsPath(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.assign(Object.create(null), value)
      : Object.create(null);
  } catch (error) {
    if (error.code === 'ENOENT') return Object.create(null);
    throw new Error('已保存的密钥文件损坏或不可读取');
  }
}
function writeEncryptedKeys(keys) {
  const file = secretsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(keys), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function updateStoredKey(alias, ciphertext, remove) {
  const keys = readEncryptedKeys();
  if (remove) delete keys[alias];
  else if (ciphertext) keys[alias] = ciphertext;
  writeEncryptedKeys(keys);
}
async function restoreStoredKeys() {
  const keys = readEncryptedKeys();
  const legacy = await requestHost('takeLegacyKeys');
  if (Object.keys(legacy).length && secureStorageAvailable()) {
    let changed = false;
    for (const [alias, key] of Object.entries(legacy)) {
      if (typeof key !== 'string' || keys[alias]) continue;
      keys[alias] = safeStorage.encryptString(key).toString('base64');
      changed = true;
    }
    if (changed) writeEncryptedKeys(keys);
  }
  if (!Object.keys(keys).length) return;
  if (!secureStorageAvailable()) throw new Error('系统安全存储不可用，无法恢复 API Key');
  const restored = {};
  for (const [alias, ciphertext] of Object.entries(keys)) {
    if (typeof ciphertext !== 'string') continue;
    restored[alias] = safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  }
  await requestHost('restoreApiKeys', { keys: restored });
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
  fs.writeFileSync(
    temp,
    JSON.stringify({ iconBackground: nextIconBackground, uiTheme: nextUiTheme }),
    { mode: 0o600 },
  );
  fs.renameSync(temp, file);
  iconBackground = nextIconBackground;
  uiTheme = nextUiTheme;
  applyIcon();
  window?.setBackgroundColor(uiTheme === 'light' ? '#FFFFFF' : '#111315');
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
    } else if (window && !window.isDestroyed()) window.webContents.send('bruin:event', message);
  });
  host.stderr.on('data', (data) => {
    if (development) process.stderr.write(data);
  });
  host.on('exit', (code, signal) => {
    for (const entry of pending.values()) entry.reject(new Error('Agent 后台进程已退出'));
    pending.clear();
    if (window && !window.isDestroyed())
      window.webContents.send('bruin:event', { type: 'hostExited', code, signal });
  });
}

function requestHost(method, params) {
  if (!host || !host.stdin.writable) return Promise.reject(new Error('Agent 后台进程不可用'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
  });
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
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (development) void window.loadURL(process.env.BRUIN_RENDERER_URL);
  else void window.loadFile(path.join(__dirname, 'build', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  loadAppearance();
  startHost();
  hostReady = restoreStoredKeys();
  createWindow();
  applyIcon();
  ipcMain.handle('bruin:request', async (event, method, params) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error('无效的界面请求');
    if (method === 'chooseWorkspace')
      return dialog
        .showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
        .then((result) => (result.canceled ? null : result.filePaths[0]));
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
      method === 'importAttachments'
    )
      throw new Error('不支持此界面操作');
    await hostReady;
    if (method === 'saveProfile' && params?.apiKey && !secureStorageAvailable())
      throw new Error('系统安全存储不可用，无法持久保存 API Key');
    const encryptedKey =
      method === 'saveProfile' && params?.apiKey
        ? safeStorage.encryptString(params.apiKey).toString('base64')
        : undefined;
    const previousProfile =
      method === 'saveProfile'
        ? (await requestHost('bootstrap')).config.profiles.find(
            (item) => item.alias === params?.alias,
          )
        : null;
    const result = await requestHost(method, params || {});
    if (method === 'saveProfile') {
      const removeKey = Boolean(
        params?.clearApiKey ||
        (previousProfile && previousProfile.provider !== params?.provider && !params?.apiKey),
      );
      if (params?.apiKey || removeKey)
        updateStoredKey(String(params.alias), encryptedKey, removeKey);
    }
    if (method === 'removeProfile') updateStoredKey(String(params?.alias), undefined, true);
    return result;
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('before-quit', () => {
  if (host && !host.killed) {
    host.stdin.end();
    setTimeout(() => {
      if (host && !host.killed) host.kill('SIGKILL');
    }, 2000).unref();
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
