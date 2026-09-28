import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type { ToolRequest, ToolResponse, ToolResult } from '../core/types.js';

function checkedPath(workspace: string, input: unknown, creating = false): string {
  const root = fs.realpathSync(workspace);
  const target = path.resolve(root, String(input ?? ''));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('路径超出工作区');
  // Reject symlinks at every existing component. This protects common escape paths,
  // but OS sandboxing is still needed against concurrent path replacement.
  const relative = path.relative(root, target);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('不允许符号链接路径');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  if (!creating && !fs.existsSync(target)) throw new Error('文件不存在');
  return target;
}
function readBounded(file: string, max: number): ToolResult {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('只能读取普通文件');
    const buffer = Buffer.alloc(Math.max(1, max + 1));
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const truncated = count > max;
    return {
      output:
        buffer.subarray(0, Math.min(count, max)).toString('utf8') +
        (truncated ? '\n[输出已截断]' : ''),
      isError: false,
      truncated,
    };
  } finally {
    fs.closeSync(fd);
  }
}
function replaceFile(file: string, content: Buffer, mode: number): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    for (let offset = 0; offset < content.length;) {
      const written = fs.writeSync(fd, content, offset, content.length - offset, offset);
      if (!written) throw new Error('文件写入未完成');
      offset += written;
    }
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
const active = new Map<string, () => void>();
async function command(program: string, args: string[], req: ToolRequest): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: req.workspace,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: req.workspace,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        LANG: process.env.LANG ?? 'C',
        ...(program === 'docker'
          ? {
              DOCKER_CONFIG: process.env.BRUIN_DOCKER_CONFIG ?? path.join(os.homedir(), '.docker'),
              DOCKER_HOST: process.env.DOCKER_HOST,
            }
          : {}),
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let done = false;
    const add = (b: Buffer) => {
      const remaining = Math.max(0, req.maxOutputBytes - size);
      if (remaining) {
        const part = b.subarray(0, remaining);
        chunks.push(part);
        size += part.length;
      }
      if (b.length > remaining) truncated = true;
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const kill = () => {
      if (child.pid) {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }
    };
    active.set(req.requestId, kill);
    const timer = setTimeout(kill, req.timeoutMs);
    child.on('error', (err) => {
      if (!done) {
        done = true;
        active.delete(req.requestId);
        clearTimeout(timer);
        resolve({ output: err.message, isError: true });
      }
    });
    child.on('close', (code) => {
      if (!done) {
        done = true;
        active.delete(req.requestId);
        clearTimeout(timer);
        resolve({
          output: Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[输出已截断]' : ''),
          truncated,
          exitCode: code ?? -1,
          isError: code !== 0,
        });
      }
    });
  });
}
function hasBinary(binary: string): boolean {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
    try {
      fs.accessSync(path.join(dir, binary), fs.constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}
function matchGlob(filename: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return (
    new RegExp(`^${escaped}$`, 'i').test(filename) ||
    new RegExp(`^${escaped}$`, 'i').test(path.basename(filename))
  );
}
async function fallbackSearch(req: ToolRequest): Promise<ToolResult> {
  const root = fs.realpathSync(req.workspace);
  const pattern = String(req.input.pattern ?? '');
  const glob = typeof req.input.glob === 'string' && req.input.glob ? req.input.glob : undefined;
  if (!pattern) return { output: '', isError: false, exitCode: 0 };
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let matchesCount = 0;
  const appendMatch = (line: string): boolean => {
    const buf = Buffer.from(line);
    const remaining = Math.max(0, req.maxOutputBytes - size);
    if (remaining) {
      const part = buf.subarray(0, remaining);
      chunks.push(part);
      size += part.length;
    }
    if (buf.length > remaining) {
      truncated = true;
      return false;
    }
    matchesCount++;
    return matchesCount < 100;
  };
  async function searchFile(fullPath: string, relPath: string): Promise<boolean> {
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > 5_000_000) return true;
      const fd = fs.openSync(fullPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const header = Buffer.alloc(Math.min(512, stat.size));
        const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
        for (let j = 0; j < bytesRead; j++) {
          if (header[j] === 0) return true;
        }
      } finally {
        fs.closeSync(fd);
      }
      const stream = fs.createReadStream(fullPath, { encoding: 'utf8' });
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });
      let lineNum = 0;
      try {
        for await (const line of rl) {
          lineNum++;
          if (line.includes(pattern)) {
            const formatted = `${relPath}:${lineNum}:${line}\n`;
            if (!appendMatch(formatted)) {
              return false;
            }
          }
        }
      } finally {
        rl.close();
        stream.destroy();
      }
    } catch {}
    return true;
  }
  async function walk(currentDir: string): Promise<boolean> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.bruin')
        continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        try {
          if (fs.lstatSync(fullPath).isSymbolicLink()) continue;
        } catch {
          continue;
        }
        if (!(await walk(fullPath))) return false;
      } else if (entry.isFile()) {
        try {
          if (fs.lstatSync(fullPath).isSymbolicLink()) continue;
        } catch {
          continue;
        }
        const relPath = path.relative(root, fullPath);
        if (glob && !matchGlob(relPath, glob)) continue;
        if (!(await searchFile(fullPath, relPath))) return false;
      }
    }
    return true;
  }
  await walk(root);
  return {
    output: Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[输出已截断]' : ''),
    truncated,
    exitCode: matchesCount > 0 ? 0 : 1,
    isError: false,
  };
}
async function handle(req: ToolRequest): Promise<ToolResult> {
  if (Buffer.byteLength(JSON.stringify(req.input)) > 1_000_000) throw new Error('工具输入过大');
  if (!fs.statSync(req.workspace).isDirectory()) throw new Error('工作区不是目录');
  switch (req.name) {
    case 'read_file': {
      const file = checkedPath(req.workspace, req.input.path);
      if (file === fs.realpathSync(req.workspace)) throw new Error('路径不能是工作区根目录');
      return readBounded(file, req.maxOutputBytes);
    }
    case 'write_file': {
      const file = checkedPath(req.workspace, req.input.path, true);
      if (file === fs.realpathSync(req.workspace)) throw new Error('路径不能是工作区根目录');
      const parent = path.dirname(file);
      const root = fs.realpathSync(req.workspace);
      let current = root;
      for (const component of path.relative(root, parent).split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        try {
          fs.mkdirSync(current, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('父路径不是工作区内的真实目录');
      }
      checkedPath(req.workspace, parent);
      let mode = 0o600;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('只能写入普通文件');
        mode = stat.mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      replaceFile(file, Buffer.from(String(req.input.content ?? '')), mode);
      return { output: `已写入 ${path.relative(root, file)}`, isError: false };
    }
    case 'edit_file': {
      const root = fs.realpathSync(req.workspace);
      const file = checkedPath(req.workspace, req.input.path);
      if (file === root) throw new Error('路径不能是工作区根目录');
      const old = String(req.input.oldText ?? '');
      const replacement = String(req.input.newText ?? '');
      if (!old) throw new Error('oldText 不能为空');
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error('只能编辑普通文件');
        if (stat.size > 5_000_000) throw new Error('文件过大，无法使用 edit_file 编辑');
        const source = fs.readFileSync(fd, 'utf8');
        const parts = source.split(old);
        if (parts.length === 1) throw new Error('未找到要替换的文本 (oldText)');
        if (parts.length > 2)
          throw new Error(`要替换的文本 (oldText) 在文件中出现了 ${parts.length - 1} 次，必须唯一`);
        const updated = Buffer.from(parts[0] + replacement + parts[1]);
        replaceFile(file, updated, stat.mode & 0o777);
      } finally {
        fs.closeSync(fd);
      }
      return { output: `已编辑 ${path.relative(root, file)}`, isError: false };
    }
    case 'search': {
      if (!hasBinary('rg')) return fallbackSearch(req);
      const args = ['-n', '--max-count', '100'];
      if (typeof req.input.glob === 'string' && req.input.glob) args.push('--glob', req.input.glob);
      args.push('--', String(req.input.pattern ?? ''));
      return command('rg', args, req);
    }
    case 'shell': {
      const shell = String(req.input.command ?? '');
      if (!shell.trim()) throw new Error('空命令');
      if (process.env.BRUIN_SHELL_BACKEND === 'docker') {
        const image = process.env.BRUIN_DOCKER_IMAGE;
        if (!image) throw new Error('Docker 执行需要 BRUIN_DOCKER_IMAGE');
        return command(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--read-only',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--pids-limit',
            '128',
            '--memory',
            '1g',
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=256m',
            '-v',
            `${fs.realpathSync(req.workspace)}:/workspace:rw`,
            '-w',
            '/workspace',
            '-e',
            'HOME=/workspace',
            image,
            'sh',
            '-lc',
            shell,
          ],
          req,
        );
      }
      if (process.env.BRUIN_ALLOW_UNSANDBOXED_SHELL === '1')
        return command(
          process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          process.platform === 'win32' ? ['/c', shell] : ['-lc', shell],
          req,
        );
      if (process.platform === 'darwin') {
        const root = fs.realpathSync(req.workspace).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
        const tmpReal = fs
          .realpathSync(os.tmpdir())
          .replaceAll('\\', '\\\\')
          .replaceAll('"', '\\"');
        const profile = `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath "${root}")) (allow file-write* (subpath "/private/tmp")) (allow file-write* (subpath "${tmpReal}"))`;
        return command('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-lc', shell], req);
      }
      throw new Error(
        '当前平台缺少已配置的 Shell 沙箱，拒绝执行。可显式设置 BRUIN_ALLOW_UNSANDBOXED_SHELL=1（不安全）。',
      );
    }
    default:
      throw new Error('未知工具');
  }
}
process.on('message', async (raw: ToolRequest | { type: 'cancel'; requestId: string }) => {
  if ('type' in raw && raw.type === 'cancel') {
    active.get(raw.requestId)?.();
    return;
  }
  const request = raw as ToolRequest;
  const result = await handle(request).catch((err: unknown): ToolResult => ({
    output: err instanceof Error ? err.message : String(err),
    isError: true,
  }));
  const reply: ToolResponse = { requestId: request.requestId, result };
  process.send?.(reply);
});

process.on('disconnect', () => {
  for (const kill of active.values()) kill();
  process.exit(0);
});
