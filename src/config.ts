import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
});
export const mcpServerSchema = z.discriminatedUnion('transport', [
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
  }),
]);
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
    return { profiles: [], marketplaces: [], mcpServers: [], hooks: [] };
  const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as {
    profiles?: Array<{ alias?: string; apiKeyEnv?: string }>;
  };
  let migrated = false;
  for (const profile of raw.profiles ?? []) {
    const value = profile.apiKeyEnv;
    if (typeof value !== 'string' || validApiKeyEnv(value)) continue;
    // Older desktop versions allowed a key to be entered as an environment variable name.
    // Move recognizable keys to process memory and remove the plaintext from config.json.
    if (profile.alias && looksLikeApiKey(value)) setRuntimeApiKey(profile.alias, value);
    delete profile.apiKeyEnv;
    migrated = true;
    migratedLegacyKey = true;
  }
  const config = configSchema.parse(raw);
  if (migrated) saveConfig(config);
  return config;
}
export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const temp = `${configPath()}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(configSchema.parse(config), null, 2), { mode: 0o600 });
  fs.renameSync(temp, configPath());
}
export function findProfile(alias?: string): ModelProfile {
  const config = loadConfig();
  const name = alias ?? config.defaultProfile;
  if (!name) throw new Error('未配置模型。先运行 bruin model add ...');
  const profile = config.profiles.find((x) => x.alias === name);
  if (!profile) throw new Error(`模型配置不存在: ${name}`);
  return profile;
}
