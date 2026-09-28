import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { dataDir, loadConfig, saveConfig, updateConfig } from '../config.js';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: string;
  revision: string;
  enabled: boolean;
}
function skillRoot(): string {
  return path.join(dataDir(), 'skills');
}
const builtinRoot = fileURLToPath(new URL('../../skills/builtin/', import.meta.url));
function builtinSettingsPath(): string {
  return path.join(dataDir(), 'builtin-skills.json');
}
function builtinSettings(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(builtinSettingsPath(), 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).filter(([_, enabled]) => typeof enabled === 'boolean'),
      ) as Record<string, boolean>;
  } catch {
    /* Default built-in skills are enabled. */
  }
  return {};
}
function setBuiltinEnabled(name: string, enabled: boolean): void {
  const settings = { ...builtinSettings(), [name]: enabled };
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const temp = `${builtinSettingsPath()}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(temp, builtinSettingsPath());
}
function builtinSkills(): SkillInfo[] {
  if (!fs.existsSync(builtinRoot)) return [];
  const settings = builtinSettings();
  return fs
    .readdirSync(builtinRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(builtinRoot, entry.name);
      const manifest = parseManifest(dir);
      const revision = createHash('sha256')
        .update(fs.readFileSync(path.join(dir, 'SKILL.md')))
        .digest('hex');
      return {
        ...manifest,
        path: dir,
        source: `builtin:${manifest.name}`,
        revision,
        enabled: settings[manifest.name] !== false,
      };
    });
}
function safeName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
    throw new Error('Skill 名称必须为小写字母、数字、- 或 _');
  return name;
}
function sourceUrl(source: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return `https://github.com/${source}.git`;
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(source)) return source;
  throw new Error('仅支持 GitHub owner/repo 或 https://github.com/owner/repo');
}
function safeRef(ref: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) || ref.includes('..'))
    throw new Error('无效的 Git ref');
  return ref;
}
function parseManifest(dir: string): { name: string; description: string } {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) throw new Error('缺少 SKILL.md');
  const raw = fs.readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  if (!match) throw new Error('SKILL.md 缺少 YAML front matter');
  const front = YAML.parse(match[1]) as { name?: unknown; description?: unknown };
  const name = typeof front.name === 'string' ? front.name : '';
  const description = typeof front.description === 'string' ? front.description : '';
  if (!name || !description) throw new Error('Skill 需要 name 和 description');
  return { name: safeName(name), description };
}
function copySafe(source: string, destination: string): void {
  const files: Array<{ from: string; to: string }> = [];
  let total = 0;
  function walk(dir: string, rel: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Skill 不允许符号链接');
      const next = path.join(rel, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, next);
      else if (entry.isFile()) {
        const size = fs.statSync(full).size;
        total += size;
        if (files.length >= 500 || total > 25 * 1024 * 1024)
          throw new Error('Skill 超过文件数量或大小限制');
        files.push({ from: full, to: path.join(destination, next) });
      } else throw new Error('Skill 包含不支持的文件类型');
    }
  }
  walk(source, '');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(file.from, file.to);
    fs.chmodSync(file.to, 0o600);
  }
}
function installDirectory(dir: string, source: string, revision: string): SkillInfo {
  const manifest = parseManifest(dir);
  if (builtinSkills().some((skill) => skill.name === manifest.name))
    throw new Error('此名称已由内置 Skill 使用');
  const root = skillRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const final = path.join(root, manifest.name);
  const stage = path.join(root, `.stage-${randomUUID()}`);
  copySafe(dir, stage);
  const enabled = source.startsWith('local:');
  const info = { ...manifest, path: final, source, revision, enabled };
  fs.writeFileSync(
    path.join(stage, '.bruin-source.json'),
    JSON.stringify({ source, revision, enabled }, null, 2),
    { mode: 0o600 },
  );
  const prior = fs.existsSync(final) ? path.join(root, `.old-${randomUUID()}`) : undefined;
  if (prior) fs.renameSync(final, prior);
  try {
    fs.renameSync(stage, final);
    if (prior) fs.rmSync(prior, { recursive: true, force: true });
  } catch (e) {
    if (prior && fs.existsSync(prior)) fs.renameSync(prior, final);
    throw e;
  }
  return info;
}
export function installLocal(dir: string): SkillInfo {
  return installDirectory(
    path.resolve(dir),
    `local:${path.resolve(dir)}`,
    createHash('sha256')
      .update(fs.readFileSync(path.join(dir, 'SKILL.md')))
      .digest('hex'),
  );
}
export function installGithub(repo: string, subdir: string, ref = 'HEAD'): SkillInfo {
  const url = sourceUrl(repo);
  safeRef(ref);
  if (path.isAbsolute(subdir) || subdir.split(/[\\/]/).includes('..'))
    throw new Error('无效的 Skill 子目录');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-skill-'));
  try {
    execFileSync('git', ['clone', '--quiet', '--no-checkout', url, temp], {
      timeout: 120000,
      stdio: 'pipe',
    });
    execFileSync('git', ['-C', temp, 'checkout', '--quiet', ref], {
      timeout: 30000,
      stdio: 'pipe',
    });
    const revision = execFileSync('git', ['-C', temp, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    return installDirectory(path.join(temp, subdir), `github:${repo}:${subdir}`, revision);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
export function listSkills(): SkillInfo[] {
  const root = skillRoot();
  const installed = !fs.existsSync(root)
    ? []
    : fs
        .readdirSync(root, { withFileTypes: true })
        .filter((x) => x.isDirectory() && !x.name.startsWith('.'))
        .flatMap((x) => {
          const dir = path.join(root, x.name);
          try {
            const manifest = parseManifest(dir);
            const source = JSON.parse(
              fs.readFileSync(path.join(dir, '.bruin-source.json'), 'utf8'),
            );
            return [
              {
                ...manifest,
                path: dir,
                source: source.source,
                revision: source.revision,
                enabled: Boolean(source.enabled),
              },
            ];
          } catch {
            return [];
          }
        });
  const installedNames = new Set(installed.map((skill) => skill.name));
  return [...builtinSkills().filter((skill) => !installedNames.has(skill.name)), ...installed];
}
export function readSkill(name: string): string {
  const skill = listSkills().find((x) => x.name === name);
  if (!skill) throw new Error(`Skill 不存在: ${name}`);
  const raw = fs.readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8');
  if (raw.length > 100_000) throw new Error('Skill 内容过大');
  return raw;
}
export function loadSkill(name: string): string {
  const skill = listSkills().find((x) => x.name === name);
  if (!skill) throw new Error(`Skill 不存在: ${name}`);
  if (!skill.enabled) throw new Error('Skill 未启用。请先查看内容并执行 bruin skill enable NAME');
  return readSkill(name);
}
export function setSkillEnabled(name: string, enabled: boolean): void {
  const skill = listSkills().find((x) => x.name === name);
  if (!skill) throw new Error('Skill 不存在');
  if (skill.source.startsWith('builtin:')) {
    setBuiltinEnabled(name, enabled);
    return;
  }
  const file = path.join(skill.path, '.bruin-source.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.enabled = enabled;
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}
export function uninstallSkill(name: string): void {
  const skill = listSkills().find((x) => x.name === name);
  if (!skill) throw new Error('Skill 不存在');
  if (skill.source.startsWith('builtin:')) throw new Error('内置 Skill 不能卸载，可选择停用');
  fs.rmSync(skill.path, { recursive: true });
}
export async function updateSkill(name: string): Promise<SkillInfo> {
  const skill = listSkills().find((x) => x.name === name);
  if (!skill) throw new Error('Skill 不存在');
  if (skill.source.startsWith('builtin:')) throw new Error('内置 Skill 随应用版本更新');
  if (skill.source.startsWith('local:')) return installLocal(skill.source.slice(6));
  if (skill.source.startsWith('skills.sh:')) {
    const { installSkillsSh } = await import('./skills-sh.js');
    return installSkillsSh(skill.source.slice(10));
  }
  const detail = skill.source.slice(7);
  const separator = detail.lastIndexOf(':');
  if (separator < 0) throw new Error('无法解析 GitHub Skill 来源');
  return installGithub(detail.slice(0, separator), detail.slice(separator + 1));
}
export function addMarket(name: string, repo: string): void {
  sourceUrl(repo);
  updateConfig((cfg) => {
    cfg.marketplaces = cfg.marketplaces.filter((x) => x.name !== name);
    cfg.marketplaces.push({ name, source: repo });
    return cfg;
  });
}
export interface MarketEntry {
  name: string;
  description: string;
  path: string;
  ref?: string;
  repo?: string;
}
export function marketEntries(name: string): MarketEntry[] {
  const market = loadConfig().marketplaces.find((x) => x.name === name);
  if (!market) throw new Error('市场不存在');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-market-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', '--quiet', sourceUrl(market.source), temp], {
      timeout: 120000,
    });
    const file = path.join(temp, 'marketplace.json');
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) throw new Error('marketplace.json 必须是数组');
    return data.map((x) => {
      const item = x as MarketEntry;
      safeName(item.name);
      if (typeof item.path !== 'string' || typeof item.description !== 'string')
        throw new Error('无效的市场条目');
      if (item.repo) sourceUrl(item.repo);
      if (item.ref) safeRef(item.ref);
      return item;
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
export function installFromMarket(market: string, skillName: string): SkillInfo {
  const entry = marketEntries(market).find((x) => x.name === skillName);
  if (!entry) throw new Error('市场中没有该 Skill');
  const source = loadConfig().marketplaces.find((x) => x.name === market)!.source;
  return installGithub(entry.repo ?? source, entry.path, entry.ref);
}

export function installSnapshot(
  files: Array<{ path: string; contents: string }>,
  source: string,
  revision: string,
): SkillInfo {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-snapshot-'));
  try {
    if (files.length > 500) throw new Error('Skill 文件过多');
    let total = 0;
    for (const file of files) {
      if (!file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..'))
        throw new Error('Skill 文件路径无效');
      total += Buffer.byteLength(file.contents);
      if (total > 25 * 1024 * 1024) throw new Error('Skill 过大');
      const target = path.join(temp, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.contents);
    }
    return installDirectory(temp, source, revision);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
