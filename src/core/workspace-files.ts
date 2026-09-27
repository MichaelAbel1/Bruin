import fs from 'node:fs';
import path from 'node:path';

function checkedWorkspacePath(workspace: string, relative: string): string {
  const root = fs.realpathSync(workspace);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('路径超出工作区');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('不允许打开符号链接');
  }
  if (fs.realpathSync(target) !== target) throw new Error('路径必须是工作区内的真实路径');
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
): { path: string; content: string; truncated: boolean } {
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
    return { path: relative, content: bytes.toString('utf8'), truncated: size > limit };
  } finally {
    fs.closeSync(fd);
  }
}
