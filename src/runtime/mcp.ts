import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServerConfig } from '../config.js';

/** Connections are owned by the host. No MCP process inherits model credentials by default. */
export class McpManager {
  private clients = new Map<string, { client: Client; signature: string }>();

  private async connect(server: McpServerConfig): Promise<Client> {
    const signature = JSON.stringify(server);
    const existing = this.clients.get(server.name);
    if (existing?.signature === signature) return existing.client;
    if (existing) await this.disconnect(server.name);
    const client = new Client({ name: 'bruin', version: '0.3.1' });
    const transport =
      server.transport === 'stdio'
        ? new StdioClientTransport({
            command: server.command,
            args: server.args,
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              HOME: process.env.HOME ?? '',
              TMPDIR: process.env.TMPDIR ?? '/tmp',
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

  async listTools(server: McpServerConfig): Promise<Array<{ name: string; description?: string }>> {
    const client = await this.connect(server);
    const result = await client.listTools(undefined, { timeout: 10_000, maxTotalTimeout: 10_000 });
    return result.tools.map(({ name, description }) => ({ name, description }));
  }

  async callTool(
    server: McpServerConfig,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ output: string; isError: boolean; truncated?: boolean }> {
    const client = await this.connect(server);
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
