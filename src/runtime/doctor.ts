import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { dataDir, isAllowedWebhookUrl, parseConfig } from '../config.js';
import { registerDatabaseUse } from '../storage/database-access.js';

export function doctor() {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'Node.js',
    ok: major > 22 || (major === 22 && minor >= 12),
    detail: process.versions.node,
  });
  for (const command of ['git', 'rg']) {
    try {
      checks.push({
        name: command,
        ok: true,
        detail: execFileSync(command, ['--version'], {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).split('\n')[0],
      });
    } catch {
      checks.push({ name: command, ok: false, detail: '未找到或无法运行' });
    }
  }
  const file = path.join(dataDir(), 'sessions.sqlite');
  let release: (() => void) | undefined;
  try {
    if (fs.existsSync(file)) release = registerDatabaseUse(file);
    const db = new Database(
      fs.existsSync(file) ? file : ':memory:',
      fs.existsSync(file) ? { readonly: true, fileMustExist: true } : {},
    );
    try {
      const integrity = db.pragma('quick_check', { simple: true });
      const schema = Number(db.pragma('user_version', { simple: true }));
      checks.push({
        name: 'SQLite',
        ok: integrity === 'ok' && schema <= 8,
        detail: `${integrity}; schema=${schema}${fs.existsSync(file) ? '' : '; 数据库尚未创建'}`,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'SQLite',
      ok: false,
      detail: /备份或恢复|维护/.test(message)
        ? message
        : `数据库或原生依赖不可用${message ? ` (${message})` : ''}`,
    });
  } finally {
    release?.();
  }
  let configWebhookUrl: string | undefined;
  try {
    const configFile = path.join(dataDir(), 'config.json');
    const config = parseConfig(
      fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {},
    );
    configWebhookUrl = config.webhookUrl;
    checks.push({
      name: '配置',
      ok: config.profiles.length > 0,
      detail: `${config.profiles.length} 个模型配置；${config.mcpServers.length} 个 MCP 服务器（未发起网络请求）`,
    });
  } catch {
    checks.push({ name: '配置', ok: false, detail: '配置文件不可读取或格式无效' });
  }
  const envWebhook = process.env.BRUIN_WEBHOOK_URL?.trim();
  if (envWebhook) {
    const valid = isAllowedWebhookUrl(envWebhook);
    checks.push({
      name: 'Webhook',
      ok: valid,
      detail: valid
        ? '已通过 BRUIN_WEBHOOK_URL 配置（未发起网络请求）'
        : 'BRUIN_WEBHOOK_URL 无效：必须使用 HTTPS（或本机 localhost HTTP）且不能包含内嵌凭据',
    });
  } else if (configWebhookUrl) {
    checks.push({
      name: 'Webhook',
      ok: true,
      detail: '已通过 config.json 配置（未发起网络请求）',
    });
  }
  return { ok: checks.every((check) => check.ok), checks };
}
