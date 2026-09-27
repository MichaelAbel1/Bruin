const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const stage = path.join(root, '.desktop-runtime');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'skills'), path.join(stage, 'skills'), { recursive: true });
fs.copyFileSync(
  process.execPath,
  path.join(stage, process.platform === 'win32' ? 'node.exe' : 'node'),
);
if (process.platform !== 'win32') fs.chmodSync(path.join(stage, 'node'), 0o755);
fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: stage,
  stdio: 'inherit',
  env: {
    ...process.env,
    npm_config_cache: path.join(root, '.npm-cache'),
    npm_config_devdir: path.join(root, '.node-gyp'),
    electron_config_cache: path.join(root, '.electron-cache'),
  },
});
console.log(`Staged desktop runtime: ${stage}`);
