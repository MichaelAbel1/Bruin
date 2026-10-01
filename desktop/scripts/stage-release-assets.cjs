const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const currentVersion = pkg.version;

const releaseDir = path.join(root, 'desktop', 'release-current');
const targetDir = path.join(root, 'stage-artifacts');

if (!fs.existsSync(releaseDir)) {
  console.error(`Release directory not found: ${releaseDir}`);
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

const allowedExtensions = new Set(['.dmg', '.zip', '.appimage', '.exe']);

const entries = fs.readdirSync(releaseDir, { withFileTypes: true });
let stagedCount = 0;

for (const entry of entries) {
  if (entry.isFile()) {
    const ext = path.extname(entry.name).toLowerCase();
    if (allowedExtensions.has(ext) && entry.name.includes(currentVersion)) {
      const src = path.join(releaseDir, entry.name);
      const dst = path.join(targetDir, entry.name);
      fs.copyFileSync(src, dst);
      console.log(`Staged release asset: ${entry.name}`);
      stagedCount++;
    }
  }
}

if (stagedCount === 0) {
  console.error(
    `No matching release assets (.dmg, .zip, .AppImage, .exe) for version ${currentVersion} found in ${releaseDir}`,
  );
  process.exit(1);
}

console.log(`Successfully staged ${stagedCount} asset(s) for v${currentVersion} to ${targetDir}`);
