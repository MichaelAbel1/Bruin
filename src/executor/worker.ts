import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type { ToolRequest, ToolResponse, ToolResult } from '../core/types.js';

let macSandboxAvailable: boolean | undefined;
function isMacSandboxAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  if (macSandboxAvailable !== undefined) return macSandboxAvailable;
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], {
      stdio: 'ignore',
      timeout: 2000,
    });
    macSandboxAvailable = true;
  } catch {
    macSandboxAvailable = false;
  }
  return macSandboxAvailable;
}

let bwrapAvailable: boolean | undefined;
function findBwrap(): string | undefined {
  if (process.platform !== 'linux' || bwrapAvailable === false) return undefined;
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
    const candidate = path.join(dir, 'bwrap');
    try {
      if (fs.existsSync(candidate)) {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (bwrapAvailable === undefined) {
          try {
            execFileSync(
              candidate,
              ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'],
              {
                stdio: 'ignore',
                timeout: 2000,
              },
            );
            bwrapAvailable = true;
          } catch {
            bwrapAvailable = false;
            return undefined;
          }
        }
        return candidate;
      }
    } catch {}
  }
  bwrapAvailable = false;
  return undefined;
}

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
    let text: string;
    try {
      // A bounded preview may end inside a valid UTF-8 character. Keep it pending,
      // rather than sending a replacement character as if it belonged to the file.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, Math.min(count, max)),
        { stream: truncated },
      );
    } catch (error) {
      if (error instanceof TypeError) throw new Error('文件不是有效的 UTF-8 文本');
      throw error;
    }
    return {
      output: text + (truncated ? '\n[输出已截断]' : ''),
      isError: false,
      truncated,
    };
  } finally {
    fs.closeSync(fd);
  }
}
function replaceFile(
  root: string,
  file: string,
  content: Buffer,
  mode: number,
  expected: fs.Stats | null,
): void {
  const parent = path.dirname(file);
  const parentStat = fs.lstatSync(parent);
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
    checkedPath(root, file, true);
    const currentParent = fs.lstatSync(parent);
    if (
      !currentParent.isDirectory() ||
      currentParent.isSymbolicLink() ||
      currentParent.dev !== parentStat.dev ||
      currentParent.ino !== parentStat.ino
    )
      throw new Error('写入期间父目录发生变化');
    let current: fs.Stats | null = null;
    try {
      current = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      Boolean(current) !== Boolean(expected) ||
      (current &&
        expected &&
        (current.isSymbolicLink() ||
          current.dev !== expected.dev ||
          current.ino !== expected.ino ||
          current.size !== expected.size ||
          current.mtimeMs !== expected.mtimeMs))
    )
      throw new Error('写入期间目标文件发生变化');
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
const active = new Map<string, () => Promise<void>>();
function dockerEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    DOCKER_CONFIG: process.env.BRUIN_DOCKER_CONFIG ?? path.join(os.homedir(), '.docker'),
    DOCKER_HOST: process.env.DOCKER_HOST,
  };
}
function removeDockerContainer(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['rm', '-f', name], {
      env: dockerEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errorText += chunk.toString('utf8').slice(0, 1000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 || errorText.includes('No such container'));
    });
  });
}
function terminateWindowsTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const executable = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe')
      : 'taskkill.exe';
    const killer = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(success);
    };
    const timer = setTimeout(() => {
      killer.kill('SIGKILL');
      finish(false);
    }, 5000);
    killer.on('error', () => finish(false));
    killer.on('close', (code) => finish(code === 0));
  });
}
async function command(
  program: string,
  args: string[],
  req: ToolRequest,
  dockerName?: string,
  windowsShell = false,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: req.workspace,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: req.workspace,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        LANG: process.env.LANG ?? 'C',
        ...(process.platform === 'win32'
          ? {
              SystemRoot: process.env.SystemRoot,
              COMSPEC: process.env.COMSPEC,
              PATHEXT: process.env.PATHEXT,
              USERPROFILE: req.workspace,
            }
          : {}),
        ...(program === 'docker' ? dockerEnvironment() : {}),
      },
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: windowsShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let done = false;
    let interrupted = false;
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    let cleanupStarted: Promise<boolean> | undefined;
    const cleanup = () =>
      (cleanupStarted ??= dockerName ? removeDockerContainer(dockerName) : Promise.resolve(true));
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
    let killStarted: Promise<void> | undefined;
    const kill = () =>
      (killStarted ??= (async () => {
        interrupted = true;
        const forceClose = setTimeout(() => {
          child.kill('SIGKILL');
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, 5000);
        try {
          if (child.pid) {
            try {
              if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
              else if (!(await terminateWindowsTree(child.pid))) child.kill('SIGKILL');
            } catch {
              /* already exited */
            }
          }
          await cleanup();
          await settled;
        } finally {
          clearTimeout(forceClose);
        }
      })());
    active.set(req.requestId, kill);
    const timer = setTimeout(() => {
      void kill();
    }, req.timeoutMs);
    child.on('error', (err) => {
      if (!done) {
        done = true;
        active.delete(req.requestId);
        clearTimeout(timer);
        resolve({ output: err.message, isError: true });
        markSettled();
      }
    });
    child.on('close', async (code) => {
      if (!done) {
        done = true;
        active.delete(req.requestId);
        clearTimeout(timer);
        // A second removal closes the race between Docker creating the container and cancellation.
        const cleaned =
          dockerName && (interrupted || code !== 0)
            ? await removeDockerContainer(dockerName)
            : true;
        resolve({
          output:
            Buffer.concat(chunks).toString('utf8') +
            (truncated ? '\n[输出已截断]' : '') +
            (!cleaned ? '\n[Docker 容器清理未确认]' : ''),
          truncated,
          exitCode: code ?? -1,
          isError: code !== 0 || interrupted || !cleaned,
        });
        markSettled();
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
      let expected: fs.Stats | null = null;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('只能写入普通文件');
        mode = stat.mode & 0o777;
        expected = stat;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      replaceFile(root, file, Buffer.from(String(req.input.content ?? '')), mode, expected);
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
      let updated: Buffer;
      let mode: number;
      let expected: fs.Stats;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error('只能编辑普通文件');
        if (stat.size > 5_000_000) throw new Error('文件过大，无法使用 edit_file 编辑');
        let source: string;
        try {
          source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            fs.readFileSync(fd),
          );
        } catch (error) {
          if (error instanceof TypeError) throw new Error('文件不是有效的 UTF-8 文本');
          throw error;
        }
        const parts = source.split(old);
        if (parts.length === 1) throw new Error('未找到要替换的文本 (oldText)');
        if (parts.length > 2)
          throw new Error(`要替换的文本 (oldText) 在文件中出现了 ${parts.length - 1} 次，必须唯一`);
        updated = Buffer.from(parts[0] + replacement + parts[1]);
        mode = stat.mode & 0o777;
        expected = stat;
      } finally {
        fs.closeSync(fd);
      }
      replaceFile(root, file, updated, mode, expected);
      return { output: `已编辑 ${path.relative(root, file)}`, isError: false };
    }
    case 'search': {
      if (!hasBinary('rg')) return fallbackSearch(req);
      const args = ['-n', '--max-count', '100'];
      if (typeof req.input.glob === 'string' && req.input.glob) args.push('--glob', req.input.glob);
      args.push('--', String(req.input.pattern ?? ''));
      const result = await command('rg', args, req);
      // ripgrep uses exit code 1 for a valid search with no matches.
      if (result.exitCode === 1) return { ...result, isError: false };
      return result;
    }
    case 'shell': {
      const shell = String(req.input.command ?? '');
      if (!shell.trim()) throw new Error('空命令');
      if (process.env.BRUIN_SHELL_BACKEND === 'docker') {
        const image = process.env.BRUIN_DOCKER_IMAGE;
        if (!image) throw new Error('Docker 执行需要 BRUIN_DOCKER_IMAGE');
        const containerName = `bruin-${randomUUID()}`;
        return command(
          'docker',
          [
            'run',
            '--rm',
            '--name',
            containerName,
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
          containerName,
        );
      }
      if (process.platform === 'darwin' && isMacSandboxAvailable()) {
        const root = fs.realpathSync(req.workspace).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
        const tmpReal = fs
          .realpathSync(os.tmpdir())
          .replaceAll('\\', '\\\\')
          .replaceAll('"', '\\"');
        const profile = `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath "${root}")) (allow file-write* (subpath "/private/tmp")) (allow file-write* (subpath "${tmpReal}"))`;
        return command('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-lc', shell], req);
      }
      const bwrap = findBwrap();
      if (bwrap) {
        const root = fs.realpathSync(req.workspace);
        const tmpReal = fs.realpathSync(os.tmpdir());
        return command(
          bwrap,
          [
            '--ro-bind',
            '/',
            '/',
            '--bind',
            root,
            root,
            '--bind',
            tmpReal,
            tmpReal,
            '--dev',
            '/dev',
            '--proc',
            '/proc',
            '--tmpfs',
            '/tmp',
            '--unshare-net',
            '--die-with-parent',
            '--chdir',
            root,
            '/bin/sh',
            '-lc',
            shell,
          ],
          req,
        );
      }
      if (req.requireSandbox || process.env.BRUIN_ENFORCE_SANDBOX === '1') {
        throw new Error(
          '当前平台缺少可用的 Shell 沙箱，自动执行的 Hook 或强制沙箱模式不能直接运行宿主命令。请配置 Docker 或安装 bwrap。',
        );
      }
      return process.platform === 'win32'
        ? command(
            process.env.COMSPEC || 'cmd.exe',
            ['/d', '/s', '/c', `"${shell}"`],
            req,
            undefined,
            true,
          )
        : command('/bin/sh', ['-lc', shell], req);
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
  if (process.connected) process.send?.(reply);
});

process.on('disconnect', () => {
  void Promise.allSettled([...active.values()].map((kill) => kill())).finally(() =>
    process.exit(0),
  );
});
