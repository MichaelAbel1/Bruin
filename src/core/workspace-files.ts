import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function checkedWorkspacePath(workspace: string, relative: string, allowMissing = false): string {
  const root = fs.realpathSync(workspace);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('路径超出工作区');
  let current = root;
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('不允许打开符号链接');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (allowMissing) break;
        throw new Error('路径不存在');
      }
      throw err;
    }
  }
  if (!allowMissing && fs.realpathSync(target) !== target)
    throw new Error('路径必须是工作区内的真实路径');
  return target;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}
export function listWorkspaceEntries(workspace: string, relative = ''): WorkspaceEntry[] {
  const target = checkedWorkspacePath(workspace, relative);
  if (!fs.statSync(target).isDirectory()) throw new Error('只能展开文件夹');
  const entries = fs.readdirSync(target, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    )
    .slice(0, 300)
    .map((entry) => ({
      name: entry.name,
      path: path.join(relative, entry.name),
      kind: entry.isDirectory() ? 'directory' : 'file',
    }));
}
export function readWorkspaceFile(
  workspace: string,
  relative: string,
): { path: string; content: string; truncated: boolean; baselineContent?: string } {
  if (!relative) throw new Error('请选择文件');
  const target = checkedWorkspacePath(workspace, relative);
  const fd = fs.openSync(
    target,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('只能浏览普通文件');
    const limit = 256_000;
    const buffer = Buffer.alloc(limit + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(size, limit));
    if (bytes.includes(0)) throw new Error('二进制文件暂不支持预览');
    const content = bytes.toString('utf8');
    let baselineContent: string | undefined;
    try {
      const root = fs.realpathSync(workspace);
      const normRelative = path.relative(root, target).split(path.sep).join('/');
      const gitShow = execFileSync('git', ['show', `HEAD:${normRelative}`], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        maxBuffer: limit + 1024,
      });
      baselineContent = gitShow;
    } catch {
      // Untracked or not a git repository
    }
    return { path: relative, content, truncated: size > limit, baselineContent };
  } finally {
    fs.closeSync(fd);
  }
}

export function writeWorkspaceFile(
  workspace: string,
  relative: string,
  content: string,
): { path: string; size: number } {
  if (!relative) throw new Error('请选择文件');
  const target = checkedWorkspacePath(workspace, relative, true);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  let mode = 0o644;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('不允许修改符号链接');
    if (stat.isDirectory()) throw new Error('目标路径是一个目录');
    if (!stat.isFile()) throw new Error('只能写入普通文件');
    mode = stat.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const temp = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  const buffer = Buffer.from(content, 'utf8');
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    for (let offset = 0; offset < buffer.length;) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!written) throw new Error('文件写入未完成');
      offset += written;
    }
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
  return { path: relative, size: buffer.length };
}
