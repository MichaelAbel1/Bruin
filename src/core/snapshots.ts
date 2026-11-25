import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataDir } from '../config.js';

export const snapshotMaxBytes = 10_000_000;
export const fileContentHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function bounded(fd: number, max: number) {
  const buffer = Buffer.alloc(Math.min(max + 1, fs.fstatSync(fd).size + 1));
  let count = 0;
  while (count < buffer.length) {
    const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
    if (!read) break;
    count += read;
  }
  if (count > max || fs.fstatSync(fd).size >= buffer.length)
    throw new Error('快照读取超过大小上限或文件增长');
  return buffer.subarray(0, count);
}
function location(workspace: string) {
  const root = fs.realpathSync(workspace);
  return { root, directory: path.join(dataDir(), 'snapshots', fileContentHash(Buffer.from(root))) };
}
function checked(root: string, relative: string): string {
  const file = path.resolve(root, relative);
  if (file === root || !file.startsWith(root + path.sep)) throw new Error('快照路径超出工作区');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('快照路径不允许符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return file;
}
function bytesAt(file: string): { bytes: Buffer; stat: fs.Stats } | null {
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > snapshotMaxBytes)
      throw new Error('快照仅支持不超过 10 MB 的普通文件');
    const bytes = bounded(fd, snapshotMaxBytes);
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error('快照读取期间文件发生变化');
    return { bytes, stat };
  } finally {
    fs.closeSync(fd);
  }
}
type Snapshot = {
  id: string;
  root: string;
  path: string;
  at: string;
  before: string | null;
  beforeHash: string | null;
  mode: number;
  afterHash: string;
};
type SnapshotMeta = {
  id: string;
  root: string;
  path: string;
  at: string;
  action: 'delete_created_file' | 'restore_file';
};
export function recordSnapshot(
  workspace: string,
  file: string,
  after: Buffer,
  expectedFileVersion?: string,
  options: { allowOverQuota?: boolean } = {},
): string | undefined {
  const { root, directory } = location(workspace);
  const resolvedWorkspace = path.resolve(workspace);
  const candidate = path.isAbsolute(file) ? file : path.resolve(root, file);
  let relative: string;
  if (candidate.startsWith(root + path.sep)) {
    relative = path.relative(root, candidate);
  } else if (candidate.startsWith(resolvedWorkspace + path.sep)) {
    relative = path.relative(resolvedWorkspace, candidate);
  } else {
    relative = path.relative(root, candidate);
  }
  const target = checked(root, relative);
  const before = bytesAt(target);
  const beforeHash = before ? fileContentHash(before.bytes) : null;
  const afterHash = fileContentHash(after);
  if (expectedFileVersion !== undefined && beforeHash !== expectedFileVersion)
    throw new Error('文件自上次读取后已更改，请重新读取后再写入');
  if (beforeHash === afterHash) return;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!options.allowOverQuota) {
    const stored = fs.readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
    let totalBytes = 0;
    for (const name of stored) {
      try {
        totalBytes += fs.lstatSync(path.join(directory, name)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    if (stored.length >= 200 || totalBytes > 500_000_000)
      throw new Error('快照存储达到上限，请先备份并清理快照目录');
  }
  const id = randomUUID();
  const at = new Date().toISOString();
  const snapshot: Snapshot = {
    id,
    root,
    path: relative,
    at,
    before: before?.bytes.toString('base64') ?? null,
    beforeHash,
    mode: before ? before.stat.mode & 0o777 : 0o600,
    afterHash,
  };
  const meta: SnapshotMeta = {
    id,
    root,
    path: relative,
    at,
    action: snapshot.before === null ? 'delete_created_file' : 'restore_file',
  };
  const temp = path.join(directory, `${id}.tmp`);
  const metaTemp = path.join(directory, `${id}.meta.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(snapshot));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, path.join(directory, `${id}.json`));
    try {
      fs.writeFileSync(metaTemp, JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
      fs.renameSync(metaTemp, path.join(directory, `${id}.meta.json`));
    } catch {
      // Optional sidecar index; full snapshot .json remains authoritative.
    }
    if (process.platform !== 'win32') {
      const dir = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
    try {
      fs.unlinkSync(metaTemp);
    } catch {}
  }
  return id;
}
function readSnapshotRaw(
  workspace: string,
  id: string,
  verifyContent: boolean,
  loc?: { root: string; directory: string },
): Snapshot {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效快照 ID');
  const { root, directory } = loc ?? location(workspace);
  const file = path.join(directory, `${id}.json`);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 14_000_000) throw new Error('快照文件无效');
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bounded(fd, 14_000_000)),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('快照数据无效');
    const value = parsed as Snapshot;
    const beforeBytes =
      verifyContent && typeof value.before === 'string'
        ? Buffer.from(value.before, 'base64')
        : undefined;
    if (
      value.id !== id ||
      value.root !== root ||
      typeof value.path !== 'string' ||
      !(value.before === null || typeof value.before === 'string') ||
      typeof value.at !== 'string' ||
      !Number.isFinite(Date.parse(value.at)) ||
      (value.before === null
        ? value.beforeHash !== null
        : typeof value.beforeHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.beforeHash) ||
          (verifyContent &&
            (beforeBytes!.toString('base64') !== value.before ||
              fileContentHash(beforeBytes!) !== value.beforeHash))) ||
      !Number.isInteger(value.mode) ||
      value.mode < 0 ||
      value.mode > 0o777 ||
      !/^[a-f0-9]{64}$/.test(value.afterHash)
    )
      throw new Error('快照数据无效');
    if (verifyContent) checked(root, value.path);
    else {
      const resolved = path.resolve(root, value.path);
      if (resolved === root || !resolved.startsWith(root + path.sep))
        throw new Error('快照路径超出工作区');
    }
    return value;
  } finally {
    fs.closeSync(fd);
  }
}
function readSnapshotMeta(
  loc: { root: string; directory: string },
  id: string,
): { id: string; path: string; at: string; action: 'delete_created_file' | 'restore_file' } | null {
  const file = path.join(loc.directory, `${id}.meta.json`);
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_000) return null;
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bounded(fd, 16_000)),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Partial<SnapshotMeta>;
    if (
      value.id !== id ||
      value.root !== loc.root ||
      typeof value.path !== 'string' ||
      typeof value.at !== 'string' ||
      !Number.isFinite(Date.parse(value.at)) ||
      (value.action !== 'delete_created_file' && value.action !== 'restore_file')
    )
      return null;
    const resolved = path.resolve(loc.root, value.path);
    if (resolved === loc.root || !resolved.startsWith(loc.root + path.sep)) return null;
    return { id: value.id, path: value.path, at: value.at, action: value.action };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
function readSnapshot(workspace: string, id: string): Snapshot {
  return readSnapshotRaw(workspace, id, true);
}
export function previewSnapshot(workspace: string, id: string): string {
  const snapshot = readSnapshot(workspace, id);
  const bytes = snapshot.before === null ? Buffer.alloc(0) : Buffer.from(snapshot.before, 'base64');
  if (bytes.length > 256_000 || bytes.includes(0)) throw new Error('快照不支持文本预览');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function listSnapshots(workspace: string) {
  const loc = location(workspace);
  if (!fs.existsSync(loc.directory)) return [];
  return fs
    .readdirSync(loc.directory)
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .flatMap((name) => {
      const id = name.slice(0, -5);
      const fast = readSnapshotMeta(loc, id);
      if (fast) return [fast];
      try {
        const { path: file, at, before } = readSnapshotRaw(workspace, id, false, loc);
        return [
          {
            id,
            path: file,
            at,
            action: before === null ? ('delete_created_file' as const) : ('restore_file' as const),
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}
export function restoreSnapshot(
  workspace: string,
  id: string,
  replace: (file: string, bytes: Buffer, mode: number, expected: fs.Stats) => void,
) {
  const snapshot = readSnapshot(workspace, id);
  const { root } = location(workspace);
  const file = checked(root, snapshot.path);
  const parent = path.dirname(file);
  const parentStat = fs.lstatSync(parent);
  const current = bytesAt(file);
  if (!current || fileContentHash(current.bytes) !== snapshot.afterHash)
    throw new Error('文件已有后续修改或已删除，拒绝覆盖；请先检查差异');
  if (snapshot.before === null) {
    checked(root, snapshot.path);
    const currentParent = fs.lstatSync(parent);
    if (
      !currentParent.isDirectory() ||
      currentParent.isSymbolicLink() ||
      currentParent.dev !== parentStat.dev ||
      currentParent.ino !== parentStat.ino
    )
      throw new Error('回滚期间父目录发生变化');
    const currentTarget = fs.lstatSync(file);
    if (
      currentTarget.isSymbolicLink() ||
      !currentTarget.isFile() ||
      currentTarget.dev !== current.stat.dev ||
      currentTarget.ino !== current.stat.ino ||
      currentTarget.size !== current.stat.size ||
      currentTarget.mtimeMs !== current.stat.mtimeMs
    )
      throw new Error('回滚期间文件发生变化');
    fs.unlinkSync(file);
  } else {
    const before = Buffer.from(snapshot.before, 'base64');
    if (before.length > snapshotMaxBytes) throw new Error('快照内容过大');
    replace(file, before, snapshot.mode, current.stat);
  }
  return { path: snapshot.path, action: snapshot.before === null ? 'deleted' : 'restored' };
}
