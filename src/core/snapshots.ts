import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataDir } from '../config.js';

const limit = 10_000_000;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
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
  return { root, directory: path.join(dataDir(), 'snapshots', hash(Buffer.from(root))) };
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
    if (!stat.isFile() || stat.size > limit) throw new Error('快照仅支持不超过 10 MB 的普通文件');
    const bytes = bounded(fd, limit);
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
export function recordSnapshot(workspace: string, file: string, after: Buffer): string | undefined {
  const { root, directory } = location(workspace);
  const relative = path.relative(root, file);
  const target = checked(root, relative);
  const before = bytesAt(target);
  if (before && hash(before.bytes) === hash(after)) return;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stored = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  if (
    stored.length >= 200 ||
    stored.reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0) >
      500_000_000
  )
    throw new Error('快照存储达到上限，请先备份并清理快照目录');
  const id = randomUUID();
  const snapshot: Snapshot = {
    id,
    root,
    path: relative,
    at: new Date().toISOString(),
    before: before?.bytes.toString('base64') ?? null,
    beforeHash: before ? hash(before.bytes) : null,
    mode: before ? before.stat.mode & 0o777 : 0o600,
    afterHash: hash(after),
  };
  const temp = path.join(directory, `${id}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(snapshot));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, path.join(directory, `${id}.json`));
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
  }
  return id;
}
function readSnapshot(workspace: string, id: string): Snapshot {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效快照 ID');
  const { root, directory } = location(workspace);
  const file = path.join(directory, `${id}.json`);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 14_000_000) throw new Error('快照文件无效');
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bounded(fd, 14_000_000)),
    ) as Snapshot;
    if (
      value.id !== id ||
      value.root !== root ||
      typeof value.path !== 'string' ||
      !(value.before === null || typeof value.before === 'string') ||
      typeof value.at !== 'string' ||
      !Number.isFinite(Date.parse(value.at)) ||
      (value.before === null
        ? value.beforeHash !== null
        : Buffer.from(value.before, 'base64').toString('base64') !== value.before ||
          hash(Buffer.from(value.before, 'base64')) !== value.beforeHash) ||
      !Number.isInteger(value.mode) ||
      value.mode < 0 ||
      value.mode > 0o777 ||
      !/^[a-f0-9]{64}$/.test(value.afterHash)
    )
      throw new Error('快照数据无效');
    checked(root, value.path);
    return value;
  } finally {
    fs.closeSync(fd);
  }
}
export function previewSnapshot(workspace: string, id: string): string {
  const snapshot = readSnapshot(workspace, id);
  const bytes = snapshot.before === null ? Buffer.alloc(0) : Buffer.from(snapshot.before, 'base64');
  if (bytes.length > 256_000 || bytes.includes(0)) throw new Error('快照不支持文本预览');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function listSnapshots(workspace: string) {
  const { directory } = location(workspace);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .map((name) => {
      const { id, path: file, at, before } = readSnapshot(workspace, name.slice(0, -5));
      return {
        id,
        path: file,
        at,
        action: before === null ? 'delete_created_file' : 'restore_file',
      };
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
  const current = bytesAt(file);
  if (!current || hash(current.bytes) !== snapshot.afterHash)
    throw new Error('文件已有后续修改或已删除，拒绝覆盖；请先检查差异');
  if (snapshot.before === null) {
    const again = bytesAt(checked(root, snapshot.path));
    if (!again || hash(again.bytes) !== snapshot.afterHash) throw new Error('回滚期间文件发生变化');
    fs.unlinkSync(file);
  } else {
    const before = Buffer.from(snapshot.before, 'base64');
    if (before.length > limit) throw new Error('快照内容过大');
    replace(file, before, snapshot.mode, current.stat);
  }
  return { path: snapshot.path, action: snapshot.before === null ? 'deleted' : 'restored' };
}
