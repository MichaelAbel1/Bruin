import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServerConfig } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

function resolveExecutable(command: string, workspace: string): string {
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\')))
    return fs.realpathSync(path.isAbsolute(command) ? command : path.join(workspace, command));
  const extensions =
    process.platform === 'win32'
      ? path.extname(command)
        ? ['']
        : ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')]
      : [''];
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
    for (const ext of extensions) {
      const candidate = path.join(directory, command + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync(candidate);
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  throw new Error(`MCP 启动命令不存在: ${command}`);
}
function sandboxProfile(workspace: string, _executable: string): string {
  const root = fs.realpathSync(workspace).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  if (!fs.statSync(root).isDirectory()) throw new Error('MCP 工作区不是目录');
  return `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath "${root}")) (allow file-write* (subpath "/private/tmp")) (allow file-write* (subpath "/tmp"))`;
}

/** Connections are owned by the host. No MCP process inherits model credentials by default. */
export class McpManager {
  private clients = new Map<string, { client: Client; signature: string }>();
  private connecting = new Map<string, Promise<Client>>();
  private operations = new Map<string, Promise<unknown>>();
  private closing = false;

  private async serialize<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(name);
    const pending = (previous?.catch(() => {}) ?? Promise.resolve()).then(operation);
    this.operations.set(name, pending);
    try {
      return await pending;
    } finally {
      if (this.operations.get(name) === pending) this.operations.delete(name);
    }
  }

  private async connect(server: McpServerConfig, workspace?: string): Promise<Client> {
    if (this.closing) throw new Error('MCP 管理器已关闭');
    const previous = this.connecting.get(server.name);
    const pending = (previous?.catch(() => {}) ?? Promise.resolve()).then(() =>
      this.connectUnshared(server, workspace),
    );
    this.connecting.set(server.name, pending);
    try {
      return await pending;
    } finally {
      if (this.connecting.get(server.name) === pending) this.connecting.delete(server.name);
    }
  }

  private async connectUnshared(server: McpServerConfig, workspace?: string): Promise<Client> {
    if (this.closing) throw new Error('MCP 管理器已关闭');
    // Direct library callers predating workspace support use the server script's directory.
    // Desktop and agent calls always pass the selected session workspace explicitly.
    const script =
      server.transport === 'stdio' && !workspace
        ? server.args.find((arg) => path.isAbsolute(arg) && fs.existsSync(arg))
        : undefined;
    const root =
      server.transport === 'stdio'
        ? fs.realpathSync(workspace ?? (script ? path.dirname(script) : process.cwd()))
        : undefined;
    const executable =
      server.transport === 'stdio' ? resolveExecutable(server.command, root!) : undefined;
    const signature = JSON.stringify({ server, root });
    const existing = this.clients.get(server.name);
    if (existing?.signature === signature) return existing.client;
    if (existing) await this.disconnectConnected(server.name);
    const client = new Client({ name: 'bruin', version: '0.6.0' });

    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (server.transport === 'stdio') {
      const useMac = isMacSandboxAvailable();
      const bwrap = findBwrap();
      if (process.env.BRUIN_ENFORCE_SANDBOX === '1' && !useMac && !bwrap) {
        throw new Error('当前系统缺少可用的 MCP stdio 沙箱，且设置了强制沙箱模式');
      }
      let command = executable!;
      let args = server.args;
      if (useMac) {
        command = '/usr/bin/sandbox-exec';
        args = ['-p', sandboxProfile(root!, executable!), executable!, ...server.args];
      } else if (bwrap) {
        command = bwrap;
        args = [
          '--ro-bind',
          '/',
          '/',
          '--bind',
          root!,
          root!,
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--tmpfs',
          '/tmp',
          '--die-with-parent',
          '--chdir',
          root!,
          executable!,
          ...server.args,
        ];
      }
      transport = new StdioClientTransport({
        command,
        args,
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: root!,
          TMPDIR: root!,
          LANG: process.env.LANG ?? 'C',
          ...(process.platform === 'win32'
            ? {
                SystemRoot: process.env.SystemRoot,
                COMSPEC: process.env.COMSPEC,
                PATHEXT: process.env.PATHEXT,
                USERPROFILE: root!,
              }
            : {}),
          ...Object.fromEntries(
            server.envNames
              .filter((name) => process.env[name] !== undefined)
              .map((name) => [name, process.env[name]!]),
          ),
        },
        stderr: 'pipe',
        maxBufferSize: 1_000_000,
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        ...(server.tokenEnv
          ? {
              authProvider: {
                token: async () => {
                  const token = process.env[server.tokenEnv!];
                  if (!token) throw new Error(`MCP Token 环境变量未设置: ${server.tokenEnv}`);
                  return token;
                },
              },
            }
          : {}),
      });
    }
    try {
      await client.connect(transport, { timeout: 10_000, maxTotalTimeout: 10_000 });
      this.clients.set(server.name, { client, signature });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  async listTools(
    server: McpServerConfig,
    workspace?: string,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    return this.serialize(server.name, async () => {
      const client = await this.connect(server, workspace);
      const result = await client.listTools(undefined, {
        timeout: 10_000,
        maxTotalTimeout: 10_000,
      });
      return result.tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        ...(inputSchema ? { inputSchema } : {}),
      }));
    });
  }

  async callTool(
    server: McpServerConfig,
    name: string,
    args: Record<string, unknown>,
    workspace?: string,
  ): Promise<{ output: string; isError: boolean; truncated?: boolean }> {
    return this.serialize(server.name, async () => {
      const client = await this.connect(server, workspace);
      const available = await client.listTools(undefined, {
        timeout: 10_000,
        maxTotalTimeout: 10_000,
      });
      if (!available.tools.some((tool) => tool.name === name))
        return { output: `MCP 工具不存在: ${name}`, isError: true };
      const result = await client.callTool(
        { name, arguments: args },
        { timeout: 30_000, maxTotalTimeout: 30_000 },
      );
      const serialized = JSON.stringify(result);
      const limit = 100_000;
      return {
        output: serialized.slice(0, limit),
        isError: Boolean(result.isError),
        truncated: serialized.length > limit,
      };
    });
  }

  async disconnect(name: string): Promise<void> {
    await this.serialize(name, async () => {
      await this.connecting.get(name)?.catch(() => {});
      await this.disconnectConnected(name);
    });
  }
  private async disconnectConnected(name: string): Promise<void> {
    const existing = this.clients.get(name);
    this.clients.delete(name);
    if (existing) await existing.client.close().catch(() => {});
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.operations.values()]);
    await Promise.allSettled([...this.connecting.values()]);
    await Promise.allSettled([...this.clients.keys()].map((name) => this.disconnect(name)));
  }
}
