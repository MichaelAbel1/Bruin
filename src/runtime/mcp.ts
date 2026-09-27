import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServerConfig } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let sandboxAvailable: boolean | undefined;
function ensureSandbox(): void {
  if (sandboxAvailable === undefined) {
    try {
      execFileSync(
        '/usr/bin/sandbox-exec',
        ['-p', '(version 1) (allow default)', '/usr/bin/true'],
        {
          stdio: 'ignore',
          timeout: 3000,
        },
      );
      sandboxAvailable = true;
    } catch {
      sandboxAvailable = false;
    }
  }
  if (!sandboxAvailable) throw new Error('macOS MCP stdio 沙箱不可用，已拒绝启动服务器');
}

function resolveExecutable(command: string, workspace: string): string {
  if (command.includes('/'))
    return fs.realpathSync(path.isAbsolute(command) ? command : path.join(workspace, command));
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`MCP 启动命令不存在: ${command}`);
}
function sandboxProfile(workspace: string, executable: string): string {
  const root = fs.realpathSync(workspace);
  if (!fs.statSync(root).isDirectory()) throw new Error('MCP 工作区不是目录');
  const allowed = [
    root,
    '/usr',
    '/System',
    '/Library',
    '/dev/null',
    '/dev/urandom',
    '/dev/random',
    '/dev/fd',
    path.dirname(executable),
  ];
  const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return `(version 1) (deny default) (allow process*) (allow sysctl-read) (allow mach-lookup) (allow file-read* ${allowed.map((item) => `(subpath ${quote(item)})`).join(' ')}) (allow file-write* (subpath ${quote(root)}))`;
}

/** Connections are owned by the host. No MCP process inherits model credentials by default. */
export class McpManager {
  private clients = new Map<string, { client: Client; signature: string }>();

  private async connect(server: McpServerConfig, workspace?: string): Promise<Client> {
    if (server.transport === 'stdio' && process.platform !== 'darwin')
      throw new Error('当前平台没有可用的 MCP stdio 文件沙箱，已拒绝启动');
    if (server.transport === 'stdio') ensureSandbox();
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
    if (existing) await this.disconnect(server.name);
    const client = new Client({ name: 'bruin', version: '0.6.0' });
    const transport =
      server.transport === 'stdio'
        ? new StdioClientTransport({
            command: '/usr/bin/sandbox-exec',
            args: ['-p', sandboxProfile(root!, executable!), executable!, ...server.args],
            cwd: root,
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              HOME: root!,
              TMPDIR: root!,
              LANG: process.env.LANG ?? 'C',
              ...Object.fromEntries(
                server.envNames
                  .filter((name) => process.env[name] !== undefined)
                  .map((name) => [name, process.env[name]!]),
              ),
            },
            stderr: 'pipe',
            maxBufferSize: 1_000_000,
          })
        : new StreamableHTTPClientTransport(new URL(server.url), {
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
  ): Promise<Array<{ name: string; description?: string }>> {
    const client = await this.connect(server, workspace);
    const result = await client.listTools(undefined, { timeout: 10_000, maxTotalTimeout: 10_000 });
    return result.tools.map(({ name, description }) => ({ name, description }));
  }

  async callTool(
    server: McpServerConfig,
    name: string,
    args: Record<string, unknown>,
    workspace?: string,
  ): Promise<{ output: string; isError: boolean; truncated?: boolean }> {
    const client = await this.connect(server, workspace);
    const available = await client.listTools(undefined, {
      timeout: 10_000,
      maxTotalTimeout: 10_000,
    });
    if (!available.tools.some((tool) => tool.name === name))
      throw new Error(`MCP 工具不存在: ${name}`);
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
  }

  async disconnect(name: string): Promise<void> {
    const existing = this.clients.get(name);
    this.clients.delete(name);
    if (existing) await existing.client.close();
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.keys()].map((name) => this.disconnect(name)));
  }
}
