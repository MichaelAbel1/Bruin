const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', 'desktop/vite.config.ts'],
  { cwd: root, stdio: 'inherit' },
);
let electron;
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  electron?.kill();
  vite.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
vite.on('exit', (code) => {
  if (!stopped) {
    stop();
    process.exitCode = code || 1;
  }
});
async function waitForVite() {
  for (let attempt = 0; attempt < 80 && !stopped; attempt++) {
    const ready = await new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:5173/', (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Vite 开发服务器未启动');
}
void waitForVite()
  .then(() => {
    if (stopped) return;
    electron = spawn(require('electron'), ['desktop/main.cjs'], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        BRUIN_RENDERER_URL: 'http://127.0.0.1:5173/',
        BRUIN_NODE_BINARY: process.execPath,
      },
    });
    electron.on('exit', (code) => {
      stop();
      process.exitCode = code || 0;
    });
  })
  .catch((error) => {
    console.error(error);
    stop();
    process.exitCode = 1;
  });
