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
function readSkillBytes(file: string, maxBytes: number): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('Skill 不允许符号链接');
  if (!stat.isFile()) throw new Error('Skill 只能读取普通文件');
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error('Skill 只能读取普通文件');
    if (before.size > maxBytes) throw new Error('Skill 内容过大');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1));
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    const after = fs.fstatSync(fd);
    if (count > maxBytes || after.size >= buffer.length)
      throw new Error('Skill 内容过大或读取时增长');
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('Skill 文件读取期间发生变化');
    return buffer.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
}
function readSkillText(file: string, maxBytes = 400_000): string {
  const bytes = readSkillBytes(file, maxBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Skill 文件不是有效的 UTF-8 文本');
    throw error;
  }
}
function readManifest(dir: string): string {
  const raw = readSkillText(path.join(dir, 'SKILL.md'));
  if (raw.length > 100_000) throw new Error('Skill 内容过大');
  return raw;
}
function builtinSettings(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(readSkillText(builtinSettingsPath(), 64_000));
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
      const revision = createHash('sha256').update(readManifest(dir)).digest('hex');
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
  const raw = readManifest(dir);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  if (!match) throw new Error('SKILL.md 缺少 YAML front matter');
  const front: unknown = YAML.parse(match[1]);
  if (!front || typeof front !== 'object' || Array.isArray(front))
    throw new Error('Skill front matter 必须是对象');
  const fields = front as { name?: unknown; description?: unknown };
  const name = typeof fields.name === 'string' ? fields.name : '';
  const description = typeof fields.description === 'string' ? fields.description : '';
  if (!name || !description) throw new Error('Skill 需要 name 和 description');
  return { name: safeName(name), description };
}
function copySafe(source: string, destination: string): void {
  const root = path.resolve(source);
  const files: Array<{ from: string; to: string }> = [];
  let total = 0;
  function walk(dir: string, rel: string) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error('Skill 不允许符号链接');
    if (!stat.isDirectory()) throw new Error('Skill 来源必须是普通目录');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Skill 不允许符号链接');
      const next = path.join(rel, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, next);
      else if (entry.isFile()) {
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) throw new Error('Skill 不允许符号链接');
        if (!stat.isFile()) throw new Error('Skill 只能读取普通文件');
        const size = stat.size;
        total += size;
        if (files.length >= 500 || total > 25 * 1024 * 1024)
          throw new Error('Skill 超过文件数量或大小限制');
        files.push({ from: full, to: path.join(destination, next) });
      } else throw new Error('Skill 包含不支持的文件类型');
    }
  }
  walk(root, '');
  total = 0;
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.to), { recursive: true, mode: 0o700 });
    let ancestor = path.dirname(file.from);
    while (true) {
      const stat = fs.lstatSync(ancestor);
      if (stat.isSymbolicLink()) throw new Error('Skill 不允许符号链接');
      if (!stat.isDirectory()) throw new Error('Skill 来源必须是普通目录');
      if (ancestor === root) break;
      ancestor = path.dirname(ancestor);
    }
    const bytes = readSkillBytes(file.from, 25 * 1024 * 1024 - total);
    total += bytes.length;
    fs.writeFileSync(file.to, bytes, { mode: 0o600, flag: 'wx' });
  }
}
function installDirectory(dir: string, source: string, revision: string): SkillInfo {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error('Skill 不允许符号链接');
  if (!stat.isDirectory()) throw new Error('Skill 来源必须是普通目录');
  const manifest = parseManifest(dir);
  if (builtinSkills().some((skill) => skill.name === manifest.name))
    throw new Error('此名称已由内置 Skill 使用');
  const root = skillRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const final = path.join(root, manifest.name);
  const stage = path.join(root, `.stage-${randomUUID()}`);
  let ownedStage = false;
  let committed = false;
  let failure: unknown;
  try {
    fs.mkdirSync(stage, { mode: 0o700 });
    ownedStage = true;
    copySafe(dir, stage);
    const copied = parseManifest(stage);
    if (copied.name !== manifest.name || copied.description !== manifest.description)
      throw new Error('Skill 复制期间 manifest 发生变化');
    const enabled = source.startsWith('local:');
    const snapshotRevision = enabled
      ? createHash('sha256').update(readManifest(stage)).digest('hex')
      : revision;
    const info = { ...copied, path: final, source, revision: snapshotRevision, enabled };
    fs.writeFileSync(
      path.join(stage, '.bruin-source.json'),
      JSON.stringify({ source, revision: snapshotRevision, enabled }, null, 2),
      { mode: 0o600 },
    );
    const prior = fs.existsSync(final) ? path.join(root, `.old-${randomUUID()}`) : undefined;
    if (prior) fs.renameSync(final, prior);
    try {
      fs.renameSync(stage, final);
    } catch (error) {
      if (prior) {
        try {
          fs.renameSync(prior, final);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Skill 发布失败，旧版本恢复失败，请检查 ${prior}`,
          );
        }
      }
      throw error;
    }
    committed = true;
    if (prior) {
      try {
        fs.rmSync(prior, { recursive: true, force: true });
      } catch {
        throw new Error(`Skill 已安装，但旧版本清理失败，请检查 ${prior}`);
      }
    }
    return info;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (ownedStage && !committed) {
      try {
        fs.rmSync(stage, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          `Skill 安装失败且暂存目录清理失败，请检查 ${stage}`,
        );
      }
    }
  }
}
export function installLocal(dir: string): SkillInfo {
  return installDirectory(path.resolve(dir), `local:${path.resolve(dir)}`, '');
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
            const source = JSON.parse(readSkillText(path.join(dir, '.bruin-source.json'), 64_000));
            if (
              !source ||
              typeof source !== 'object' ||
              Array.isArray(source) ||
              typeof source.source !== 'string' ||
              typeof source.revision !== 'string' ||
              typeof source.enabled !== 'boolean'
            )
              throw new Error('Skill 来源元数据无效');
            return [
              {
                ...manifest,
                path: dir,
                source: source.source,
                revision: source.revision,
                enabled: source.enabled,
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
  return readManifest(skill.path);
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
  const data = JSON.parse(readSkillText(file, 64_000));
  data.enabled = enabled;
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
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
