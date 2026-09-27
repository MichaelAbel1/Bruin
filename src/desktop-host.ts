import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
  dataDir,
  findProfile,
  getRuntimeApiKey,
  loadConfig,
  looksLikeApiKey,
  saveConfig,
  setRuntimeApiKey,
  validApiKeyEnv,
} from './config.js';
import { SqliteEventStore } from './storage/event-store.js';
import { AiSdkGateway } from './providers/gateway.js';
import { ProcessExecutor } from './executor/client.js';
import { AgentRunner } from './core/agent.js';
import {
  addMarket,
  installFromMarket,
  installGithub,
  installLocal,
  listSkills,
  marketEntries,
  readSkill,
  setSkillEnabled,
  uninstallSkill,
  updateSkill,
} from './skills/registry.js';
import type { ModelProfile, ProviderKind, Session, ToolCall } from './core/types.js';

type Request = { id: string; method: string; params?: Record<string, unknown> };
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const event = (type: string, data: Record<string, unknown> = {}) => send({ type, ...data });
const store = new SqliteEventStore(path.join(dataDir(), 'sessions.sqlite'));
const executor = new ProcessExecutor();
let active: { sessionId: string; controller: AbortController } | undefined;
const approvals = new Map<string, (approved: boolean) => void>();
const reviewed = new Set<string>();

// Remove secrets accidentally persisted by older desktop versions from session profiles.
const startupConfig = loadConfig();
for (const session of store.listSessions()) {
  const legacyValue = session.profile.apiKeyEnv;
  if (!legacyValue || validApiKeyEnv(legacyValue)) continue;
  if (!getRuntimeApiKey(session.profile.alias) && looksLikeApiKey(legacyValue))
    setRuntimeApiKey(session.profile.alias, legacyValue);
  const current = startupConfig.profiles.find((p) => p.alias === session.profile.alias);
  const cleanProfile = current ?? { ...session.profile, apiKeyEnv: undefined };
  store.setProfile(session.id, cleanProfile);
}

const runner = new AgentRunner(store, new AiSdkGateway(), executor, {
  text: (delta) => event('text', { sessionId: active?.sessionId, delta }),
  notice: (message) => event('notice', { sessionId: active?.sessionId, message }),
  approve: (call: ToolCall, reason: string) =>
    new Promise<boolean>((resolve) => {
      const approvalId = randomUUID();
      approvals.set(approvalId, resolve);
      event('approval', { sessionId: active?.sessionId, approvalId, call, reason });
    }),
});
function getSession(id: unknown): Session {
  const session = store.getSession(String(id ?? ''));
  if (!session) throw new Error('会话不存在');
  return session;
}
function needsReview(id: string): boolean {
  if (reviewed.has(id)) return false;
  const events = store.events(id);
  const lastCompleted = [...events].reverse().find((e) => e.type === 'turn_completed')?.seq ?? 0;
  return events.some((e) => e.seq > lastCompleted && e.type === 'tool_unknown');
}
function viewSession(session: Session) {
  return { session, events: store.events(session.id), needsReview: needsReview(session.id) };
}
async function startRun(session: Session, prompt?: string): Promise<{ started: boolean }> {
  if (active) throw new Error('已有任务正在运行');
  if (needsReview(session.id)) throw new Error('请先检查执行结果未知的工具调用并确认继续');
  const controller = new AbortController();
  active = { sessionId: session.id, controller };
  event('runStarted', { sessionId: session.id });
  void runner
    .run(session, prompt, controller.signal)
    .then(() => event('runFinished', { sessionId: session.id, events: store.events(session.id) }))
    .catch((error) =>
      event('runFailed', {
        sessionId: session.id,
        message: error instanceof Error ? error.message : String(error),
        events: store.events(session.id),
      }),
    )
    .finally(() => {
      active = undefined;
      for (const resolve of approvals.values()) resolve(false);
      approvals.clear();
    });
  return { started: true };
}
async function dispatch(method: string, p: Record<string, unknown>) {
  switch (method) {
    case 'bootstrap':
      return {
        config: loadConfig(),
        sessions: store.listSessions(),
        skills: listSkills(),
        busySessionId: active?.sessionId,
      };
    case 'listSessions':
      return store.listSessions();
    case 'createSession': {
      const workspace = fs.realpathSync(String(p.workspace ?? ''));
      if (!fs.statSync(workspace).isDirectory()) throw new Error('工作区必须是目录');
      const alias =
        typeof p.profileAlias === 'string' && p.profileAlias ? p.profileAlias : undefined;
      return viewSession(store.createSession(workspace, findProfile(alias)));
    }
    case 'openSession': {
      const session = getSession(p.sessionId);
      if (active) {
        if (active.sessionId !== session.id) throw new Error('请等待当前任务完成');
        return { ...viewSession(session), recoveredUnknown: 0 };
      }
      const unknown = runner.recover(session);
      return { ...viewSession(session), recoveredUnknown: unknown };
    }
    case 'reviewUnknown': {
      const session = getSession(p.sessionId);
      reviewed.add(session.id);
      return viewSession(session);
    }
    case 'send': {
      const prompt = String(p.prompt ?? '').trim();
      if (!prompt) throw new Error('消息不能为空');
      return startRun(getSession(p.sessionId), prompt);
    }
    case 'resume':
      return startRun(getSession(p.sessionId));
    case 'cancel': {
      if (!active || active.sessionId !== String(p.sessionId)) return { cancelled: false };
      active.controller.abort();
      for (const resolve of approvals.values()) resolve(false);
      approvals.clear();
      return { cancelled: true };
    }
    case 'answerApproval': {
      const id = String(p.approvalId ?? '');
      const resolve = approvals.get(id);
      if (!resolve) throw new Error('审批请求已失效');
      approvals.delete(id);
      resolve(p.approved === true);
      return { accepted: true };
    }
    case 'setSessionModel': {
      if (active) throw new Error('任务运行中不能切换模型');
      const session = getSession(p.sessionId);
      store.setProfile(session.id, findProfile(String(p.alias ?? '')));
      return viewSession(getSession(session.id));
    }
    case 'saveProfile': {
      if (active) throw new Error('请等待当前任务完成后再修改模型');
      const alias = String(p.alias ?? '').trim();
      const provider = String(p.provider ?? '') as ProviderKind;
      const model = String(p.model ?? '').trim();
      const baseUrl = String(p.baseUrl ?? '').trim();
      if (
        !alias ||
        !model ||
        !['openai', 'anthropic', 'google', 'openai-compatible'].includes(provider)
      )
        throw new Error('模型配置不完整');
      if (provider === 'openai-compatible' && !baseUrl) throw new Error('兼容接口需要 Base URL');
      const apiKeyEnv = String(p.apiKeyEnv ?? '').trim() || undefined;
      if (apiKeyEnv && !validApiKeyEnv(apiKeyEnv))
        throw new Error(
          '密钥环境变量只能填写名称，例如 OPENAI_API_KEY；密钥值请填入 API Key 输入框',
        );
      const profile: ModelProfile = {
        alias,
        provider,
        model,
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
      };
      const config = loadConfig();
      const previous = config.profiles.find((x) => x.alias === alias);
      config.profiles = config.profiles.filter((x) => x.alias !== alias);
      config.profiles.push(profile);
      config.defaultProfile ??= alias;
      saveConfig(config);
      if (p.clearApiKey === true || (previous && previous.provider !== provider && !p.apiKey))
        setRuntimeApiKey(alias, undefined);
      else if (typeof p.apiKey === 'string' && p.apiKey) setRuntimeApiKey(alias, p.apiKey);
      for (const session of store.listSessions())
        if (
          session.profile.alias === alias &&
          JSON.stringify(session.profile) !== JSON.stringify(profile)
        )
          store.setProfile(session.id, profile);
      return loadConfig();
    }
    case 'setDefaultModel': {
      const config = loadConfig();
      const alias = String(p.alias ?? '');
      if (!config.profiles.some((x) => x.alias === alias)) throw new Error('模型配置不存在');
      config.defaultProfile = alias;
      saveConfig(config);
      return loadConfig();
    }
    case 'listSkills':
      return listSkills();
    case 'readSkill':
      return readSkill(String(p.name ?? ''));
    case 'setSkillEnabled':
      setSkillEnabled(String(p.name ?? ''), p.enabled === true);
      return listSkills();
    case 'installLocal':
      installLocal(String(p.directory ?? ''));
      return listSkills();
    case 'installGithub':
      installGithub(String(p.repo ?? ''), String(p.subdir ?? ''), String(p.ref ?? 'HEAD'));
      return listSkills();
    case 'updateSkill':
      await updateSkill(String(p.name ?? ''));
      return listSkills();
    case 'removeSkill':
      uninstallSkill(String(p.name ?? ''));
      return listSkills();
    case 'addMarket':
      addMarket(String(p.name ?? ''), String(p.repo ?? ''));
      return loadConfig().marketplaces;
    case 'marketEntries':
      return marketEntries(String(p.name ?? ''));
    case 'installFromMarket':
      installFromMarket(String(p.market ?? ''), String(p.skill ?? ''));
      return listSkills();
    default:
      throw new Error(`未知方法: ${method}`);
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    return;
  }
  void dispatch(request.method, request.params ?? {})
    .then((result) => send({ id: request.id, result }))
    .catch((error) =>
      send({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
    );
});
async function shutdown() {
  active?.controller.abort();
  for (const resolve of approvals.values()) resolve(false);
  approvals.clear();
  await executor.close();
  store.close();
}
lines.on('close', () => {
  void shutdown().then(() => process.exit(0));
});
