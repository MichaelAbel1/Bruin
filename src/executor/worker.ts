import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
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
  const fd = fs.openSync(file, 'r');
  try {
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
async function handle(req: ToolRequest): Promise<ToolResult> {
  if (Buffer.byteLength(JSON.stringify(req.input)) > 1_000_000) throw new Error('工具输入过大');
  if (!fs.statSync(req.workspace).isDirectory()) throw new Error('工作区不是目录');
  switch (req.name) {
    case 'read_file':
      return readBounded(checkedPath(req.workspace, req.input.path), req.maxOutputBytes);
    case 'write_file': {
      const file = checkedPath(req.workspace, req.input.path, true);
      const parent = path.dirname(file);
      if (!fs.existsSync(parent)) throw new Error('父目录不存在');
      checkedPath(req.workspace, path.relative(req.workspace, parent));
      fs.writeFileSync(file, String(req.input.content ?? ''), { flag: 'w', mode: 0o600 });
      return { output: `已写入 ${path.relative(req.workspace, file)}`, isError: false };
    }
    case 'edit_file': {
      const file = checkedPath(req.workspace, req.input.path);
      const old = String(req.input.oldText ?? '');
      const replacement = String(req.input.newText ?? '');
      if (!old) throw new Error('oldText 不能为空');
      const source = fs.readFileSync(file, 'utf8');
      if (source.split(old).length !== 2) throw new Error('oldText 必须恰好出现一次');
      fs.writeFileSync(file, source.replace(old, replacement));
      return { output: `已编辑 ${path.relative(req.workspace, file)}`, isError: false };
    }
    case 'search': {
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
        const profile = `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath "${root}")) (allow file-write* (subpath "/private/tmp"))`;
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
