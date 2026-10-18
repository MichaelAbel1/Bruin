import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { acquireDatabaseMaintenance } from './database-access.js';
import { SqliteEventStore } from './event-store.js';

const roots = [
  'sessions.sqlite',
  'config.json',
  'keys.enc.json',
  'oauth.enc.json',
  'appearance.json',
  'AGENTS.md',
  'attachments',
  'snapshots',
  'skills',
  'workspaces',
];
const relativePath = z.string().refine((value) => {
  const parts = value.split('/');
  return (
    !value.includes('\\') &&
    !value.includes(':') &&
    parts.every((part) => part && part !== '.' && part !== '..') &&
    roots.includes(parts[0])
  );
}, '无效备份路径');
const manifestSchema = z.object({
  version: z.literal(1),
  sourceHome: z.string().refine(path.isAbsolute),
  createdAt: z.string(),
  schemaVersion: z.literal(8),
  externalWorkspaces: z.array(z.string()),
  files: z
    .array(
      z.object({
        path: relativePath,
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        mode: z.number().int().min(0).max(0o777),
      }),
    )
    .max(100_000),
  directories: z.array(relativePath).max(100_000).default([]),
});
type Manifest = z.infer<typeof manifestSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function checked(file: string): void {
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink())
      throw new Error(`备份路径不允许符号链接: ${current}`);
  }
}
async function hashFile(file: string): Promise<string> {
  checked(file);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    throw new Error('备份仅支持普通文件');
  }
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { fd })) hash.update(chunk);
  return hash.digest('hex');
}
async function copyFile(source: string, target: string, mode: number): Promise<void> {
  checked(source);
  const fd = fs.openSync(
    source,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  const before = fs.fstatSync(fd);
  if (!before.isFile()) {
    fs.closeSync(fd);
    throw new Error('备份仅支持普通文件');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  await pipeline(
    fs.createReadStream(source, { fd }),
    fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }),
  );
  const after = fs.lstatSync(source);
  if (
    !after.isFile() ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  )
    throw new Error('备份源文件在复制期间发生变化');
  fs.chmodSync(target, mode);
}
function filesIn(directory: string, relative = ''): string[] {
  checked(directory);
  const result: string[] = [];
  for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, item.name);
    if (item.isDirectory()) result.push(...filesIn(directory, name));
    else if (item.isFile()) result.push(name);
    else throw new Error(`备份不支持符号链接或特殊文件: ${name}`);
  }
  return result;
}
function inspectDatabase(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error('SQLite 完整性检查失败');
    if (db.pragma('user_version', { simple: true }) !== 8)
      throw new Error('备份仅支持数据库 schema 8，请先用对应版本检查升级路径');
    if ((db.pragma('foreign_key_check') as unknown[]).length)
      throw new Error('SQLite 外键检查失败');
    return (
      db.prepare('SELECT DISTINCT workspace FROM sessions').all() as Array<{ workspace: string }>
    ).map((row) => row.workspace);
  } finally {
    db.close();
  }
}
function sourceRoot(home: string) {
  if (fs.lstatSync(home).isSymbolicLink()) throw new Error('数据目录不允许符号链接');
  const canonical = fs.realpathSync(home);
  if (canonical === path.parse(canonical).root) throw new Error('数据目录不能是文件系统根目录');
  checked(canonical);
  if (!fs.statSync(home).isDirectory()) throw new Error('数据目录无效');
  return canonical;
}
function canonicalTarget(value: string): string {
  const requested = path.resolve(value);
  let ancestor = requested;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  return path.join(fs.realpathSync(ancestor), path.relative(ancestor, requested));
}

export async function createBackup(home: string, destination: string) {
  const root = sourceRoot(home);
  const target = canonicalTarget(destination);
  if (target === root || target.startsWith(root + path.sep))
    throw new Error('备份必须保存在 BRUIN_HOME 之外');
  if (fs.existsSync(target)) throw new Error('备份目标已存在，拒绝覆盖');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  checked(path.dirname(target));
  const release = acquireDatabaseMaintenance(path.join(root, 'sessions.sqlite'));
  const staging = `${target}.tmp-${randomUUID()}`;
  try {
    const dbFile = path.join(root, 'sessions.sqlite');
    checked(dbFile);
    const workspaces = inspectDatabase(dbFile);
    fs.mkdirSync(path.join(staging, 'data'), { recursive: true, mode: 0o700 });
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      await db.backup(path.join(staging, 'data', 'sessions.sqlite'));
    } finally {
      db.close();
    }
    const copied = new Database(path.join(staging, 'data', 'sessions.sqlite'));
    try {
      copied.pragma('journal_mode = DELETE');
    } finally {
      copied.close();
    }
    const manifest: Manifest = {
      version: 1,
      sourceHome: root,
      schemaVersion: 8,
      createdAt: new Date().toISOString(),
      externalWorkspaces: workspaces.filter(
        (workspace) => !workspace.startsWith(path.join(root, 'workspaces') + path.sep),
      ),
      files: [],
      directories: [],
    };
    for (const name of roots) {
      const source = path.join(root, name);
      if (!fs.existsSync(source)) continue;
      checked(source);
      if (fs.statSync(source).isDirectory()) {
        const collect = (relative: string) => {
          manifest.directories.push(relative);
          for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true }))
            if (item.isDirectory()) collect(`${relative}/${item.name}`);
        };
        collect(name);
      }
      const entries = fs.statSync(source).isDirectory()
        ? filesIn(source).map((item) => `${name}/${item}`)
        : [name];
      for (const relative of entries) {
        const original = path.join(root, relative);
        const output = path.join(staging, 'data', relative);
        const mode = fs.statSync(original).mode & 0o777;
        if (relative !== 'sessions.sqlite') await copyFile(original, output, mode);
        fs.chmodSync(output, relative === 'sessions.sqlite' ? 0o600 : mode);
        manifest.files.push({
          path: relative,
          mode: relative === 'sessions.sqlite' ? 0o600 : mode,
          size: fs.statSync(output).size,
          sha256: await hashFile(output),
        });
      }
    }
    manifestSchema.parse(manifest);
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    if (fs.existsSync(target)) throw new Error('备份目标已存在，拒绝覆盖');
    fs.renameSync(staging, target);
    return {
      directory: target,
      files: manifest.files.length,
      externalWorkspaces: manifest.externalWorkspaces,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    release();
  }
}

async function validateBackup(
  directory: string,
): Promise<{ root: string; manifest: Manifest; token: string }> {
  const root = sourceRoot(directory);
  const manifestFile = path.join(root, 'manifest.json');
  checked(manifestFile);
  if (fs.statSync(manifestFile).size > 20_000_000) throw new Error('备份清单过大');
  const raw = fs.readFileSync(manifestFile, 'utf8');
  const manifest = manifestSchema.parse(JSON.parse(raw));
  const names = manifest.files.map((file) => file.path);
  if (new Set(names).size !== names.length || !names.includes('sessions.sqlite'))
    throw new Error('备份文件清单重复或缺少数据库');
  const actual = filesIn(path.join(root, 'data'));
  if (actual.length !== names.length || actual.some((name) => !names.includes(name)))
    throw new Error('备份包含清单之外的文件');
  for (const file of manifest.files) {
    const source = path.join(root, 'data', file.path);
    if ((await hashFile(source)) !== file.sha256 || fs.statSync(source).size !== file.size)
      throw new Error(`备份文件校验失败: ${file.path}`);
  }
  inspectDatabase(path.join(root, 'data', 'sessions.sqlite'));
  return { root, manifest, token: digest(raw) };
}
export async function previewBackup(directory: string) {
  const { manifest, token } = await validateBackup(directory);
  return {
    sourceHome: manifest.sourceHome,
    createdAt: manifest.createdAt,
    schemaVersion: manifest.schemaVersion,
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    externalWorkspaces: manifest.externalWorkspaces,
    confirmation: token,
    note: '仅恢复到原 BRUIN_HOME；当前目录会保留为回退副本。外部工作区与 Git worktrees 不在备份内。',
  };
}
export async function restoreBackup(home: string, directory: string, confirmation: string) {
  const backup = await validateBackup(directory);
  const target = canonicalTarget(home);
  if (target !== backup.manifest.sourceHome)
    throw new Error('恢复路径必须与备份原 BRUIN_HOME 一致，避免工作区和快照引用失效');
  if (confirmation !== backup.token)
    throw new Error('请先 backup inspect，再使用输出的 confirmation 值确认恢复');
  if (backup.root === target || backup.root.startsWith(target + path.sep))
    throw new Error('不能从当前数据目录内部恢复');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  checked(path.dirname(target));
  if (fs.existsSync(target)) sourceRoot(target);
  const release = acquireDatabaseMaintenance(path.join(target, 'sessions.sqlite'));
  const staging = `${target}.restore-${randomUUID()}`;
  const previous = `${target}.before-restore-${randomUUID()}`;
  let moved = false;
  try {
    const worktrees = path.join(target, 'worktrees');
    if (
      fs.existsSync(worktrees) &&
      (!fs.lstatSync(worktrees).isDirectory() || fs.readdirSync(worktrees).length)
    )
      throw new Error('当前存在托管 Git worktrees，请先归档并移出数据目录后恢复');
    fs.mkdirSync(staging, { mode: 0o700 });
    for (const directory of backup.manifest.directories)
      fs.mkdirSync(path.join(staging, directory), { recursive: true, mode: 0o700 });
    for (const file of backup.manifest.files) {
      const source = path.join(backup.root, 'data', file.path);
      const output = path.join(staging, file.path);
      await copyFile(source, output, file.mode);
      if ((await hashFile(output)) !== file.sha256)
        throw new Error('备份在恢复期间发生变化，未替换数据目录');
    }
    // Keep stale in-flight work from becoming eligible for automatic replay.
    const db = new Database(path.join(staging, 'sessions.sqlite'));
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM session_leases').run();
        db.prepare(
          "UPDATE workspace_tasks SET status = 'unknown', owner = NULL, expires_at = NULL WHERE status = 'running'",
        ).run();
      })();
    } finally {
      db.close();
    }
    const staged = new SqliteEventStore(path.join(staging, 'sessions.sqlite'));
    try {
      for (const session of staged.listSessions())
        for (const job of staged.listCronJobs(session.id))
          if (job.lastStatus === 'dispatched') staged.markCronJob(job.id, 'needs_review');
    } finally {
      staged.close();
    }
    inspectDatabase(path.join(staging, 'sessions.sqlite'));
    if (fs.existsSync(target)) {
      fs.renameSync(target, previous);
      moved = true;
    }
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (moved) fs.renameSync(previous, target);
      throw error;
    }
    return { restored: target, previous: moved ? previous : undefined };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    release();
  }
}
