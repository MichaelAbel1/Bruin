const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

let window;
let host;
const pending = new Map();
const development = Boolean(process.env.BRUIN_RENDERER_URL);

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
    backgroundColor: '#111315',
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
  startHost();
  createWindow();
  ipcMain.handle('bruin:request', (event, method, params) => {
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
    return requestHost(method, params || {});
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
