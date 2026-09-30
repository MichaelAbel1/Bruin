import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelProfile } from './core/types.js';

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const runtimeKeys = new Map<string, string>();
let migratedLegacyKey = false;
export function legacyKeyWasMigrated(): boolean {
  return migratedLegacyKey;
}
export function validApiKeyEnv(name: string): boolean {
  return envNamePattern.test(name);
}
export function looksLikeApiKey(value: string): boolean {
  return /^(sk-|AIza|gsk_|xai-)/i.test(value) && value.length >= 16;
}
export function setRuntimeApiKey(alias: string, key: string | undefined): void {
  if (key) runtimeKeys.set(alias, key);
  else runtimeKeys.delete(alias);
}
export function getRuntimeApiKey(alias: string): string | undefined {
  return runtimeKeys.get(alias);
}

const profileSchema = z.object({
  alias: z.string().min(1),
  provider: z.enum(['openai', 'anthropic', 'google', 'openai-compatible']),
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().regex(envNamePattern).optional(),
  contextWindowTokens: z.number().int().min(8192).max(1_048_576).optional(),
});
export const mcpServerSchema = z
  .discriminatedUnion('transport', [
    z.object({
      name: z.string().min(1).max(80),
      transport: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      envNames: z.array(z.string().regex(envNamePattern)).default([]),
    }),
    z.object({
      name: z.string().min(1).max(80),
      transport: z.literal('http'),
      url: z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
          );
        }, '远程 MCP 服务器必须使用 HTTPS'),
      tokenEnv: z.string().regex(envNamePattern).optional(),
      oauth: z
        .object({
          clientId: z.string().min(1).optional(),
          callbackPort: z.number().int().min(1024).max(65535).optional(),
        })
        .optional(),
    }),
  ])
  .refine(
    (server) => server.transport !== 'http' || !(server.oauth && server.tokenEnv),
    'OAuth 和 Bearer Token 不能同时配置',
  );
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export const hookSchema = z.object({
  name: z.string().min(1).max(80),
  event: z.enum(['before_tool', 'after_tool', 'turn_started', 'turn_finished']),
  command: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type HookConfig = z.infer<typeof hookSchema>;
const configSchema = z.object({
  profiles: z.array(profileSchema).default([]),
  defaultProfile: z.string().optional(),
  marketplaces: z.array(z.object({ name: z.string(), source: z.string() })).default([]),
  mcpServers: z.array(mcpServerSchema).default([]),
  hooks: z.array(hookSchema).default([]),
  approvalMode: z.enum(['ask', 'autoSafe']).default('ask'),
  approvedCommands: z
    .array(
      z.object({ workspace: z.string(), command: z.string(), sessionId: z.string().optional() }),
    )
    .default([]),
});
export type AppConfig = z.infer<typeof configSchema>;
export function dataDir(): string {
  return process.env.BRUIN_HOME ?? path.join(os.homedir(), '.bruin');
}
export function configPath(): string {
  return path.join(dataDir(), 'config.json');
}
export function loadConfig(): AppConfig {
  if (!fs.existsSync(configPath()))
    return {
      profiles: [],
      marketplaces: [],
      mcpServers: [],
      hooks: [],
      approvalMode: 'ask',
      approvedCommands: [],
    };
  let raw: {
    profiles?: Array<{ alias?: string; apiKeyEnv?: string; contextWindowTokens?: number }>;
  };
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as {
      profiles?: Array<{ alias?: string; apiKeyEnv?: string; contextWindowTokens?: number }>;
    };
  } catch (error) {
    throw new Error(
      `配置文件解析失败 (${configPath()}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`配置文件格式无效 (${configPath()}): 根节点必须是对象`);
  }
  let migrated = false;
  for (const profile of Array.isArray(raw.profiles) ? raw.profiles : []) {
    if (profile === null || typeof profile !== 'object') continue;
    if (
      typeof profile.contextWindowTokens === 'number' &&
      profile.contextWindowTokens > 1_048_576
    ) {
      profile.contextWindowTokens = 1_048_576;
      migrated = true;
    }
    const value = profile.apiKeyEnv;
    if (typeof value !== 'string' || validApiKeyEnv(value)) continue;
    // Older desktop versions allowed a key to be entered as an environment variable name.
    // Move recognizable keys to process memory and remove the plaintext from config.json.
    if (profile.alias && looksLikeApiKey(value)) setRuntimeApiKey(profile.alias, value);
    delete profile.apiKeyEnv;
    migrated = true;
    migratedLegacyKey = true;
  }
  let config: AppConfig;
  try {
    config = configSchema.parse(raw);
  } catch (error) {
    throw new Error(
      `配置文件格式无效 (${configPath()}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (migrated) saveConfig(config);
  return config;
}
export function configLockPath(): string {
  return path.join(dataDir(), 'config.lock');
}

let configLockDepth = 0;

export function withConfigLock<T>(fn: () => T): T {
  if (configLockDepth > 0) {
    configLockDepth++;
    try {
      return fn();
    } finally {
      configLockDepth--;
    }
  }

  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const lockFile = configLockPath();
  const start = Date.now();
  const timeoutMs = 5000;
  let fd: number | null = null;

  while (Date.now() - start < timeoutMs) {
    try {
      fd = fs.openSync(
        lockFile,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
        0o600,
      );
      fs.writeSync(fd, `${process.pid}\n${Date.now()}`);
      break;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockFile);
          const content = fs.readFileSync(lockFile, 'utf8');
          const [pidStr, timestampStr] = content.split('\n');
          const pid = parseInt(pidStr, 10);
          const timestamp = parseInt(timestampStr, 10);
          let isAlive = false;
          if (Number.isFinite(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
              isAlive = true;
            } catch (e: unknown) {
              if ((e as { code?: string })?.code === 'ESRCH') {
                isAlive = false;
              } else {
                isAlive = true;
              }
            }
          }
          const validPid = Number.isFinite(pid) && pid > 0;
          const isExpired =
            Date.now() - (Number.isFinite(timestamp) ? timestamp : stat.mtimeMs) > 10000;
          if ((validPid && !isAlive) || (!validPid && isExpired)) {
            fs.unlinkSync(lockFile);
            continue;
          }
        } catch {
          // The creator may still be writing the lock, or another process may have removed it.
        }
        const wait = 20 + Math.floor(Math.random() * 30);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      } else {
        throw err;
      }
    }
  }

  if (fd === null) {
    throw new Error('获取配置文件锁超时，可能存在并发写入冲突');
  }

  configLockDepth++;
  try {
    return fn();
  } finally {
    configLockDepth--;
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  }
}

export function saveConfig(config: z.input<typeof configSchema>): void {
  withConfigLock(() => {
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const temp = `${configPath()}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(configSchema.parse(config), null, 2), { mode: 0o600 });
      fs.renameSync(temp, configPath());
    } finally {
      fs.rmSync(temp, { force: true });
    }
  });
}

export function updateConfig(updater: (config: AppConfig) => AppConfig): AppConfig {
  return withConfigLock(() => {
    const current = loadConfig();
    const next = updater(current);
    saveConfig(next);
    return next;
  });
}
export function findProfile(alias?: string): ModelProfile {
  const config = loadConfig();
  const name = alias ?? config.defaultProfile;
  if (!name) throw new Error('未配置模型。先运行 bruin model add ...');
  const profile = config.profiles.find((x) => x.alias === name);
  if (!profile) throw new Error(`模型配置不存在: ${name}`);
  return profile;
}
