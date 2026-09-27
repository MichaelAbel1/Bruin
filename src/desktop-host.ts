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
  mcpServerSchema,
  hookSchema,
} from './config.js';
import { SqliteEventStore } from './storage/event-store.js';
import { AiSdkGateway } from './providers/gateway.js';
import { discoverModels } from './providers/catalog.js';
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
import { RuntimeServices } from './runtime/services.js';
import {
  approvePlan,
  planBlocks,
  planState,
  setPlanMode,
  setPlanProgress,
} from './runtime/plan.js';

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

const services = new RuntimeServices(store, executor, (session, prompt, signal) =>
  new AgentRunner(
    store,
    new AiSdkGateway('read-only'),
    executor,
    {
      text() {},
      notice() {},
      async approve() {
        return false;
      },
    },
    undefined,
    true,
  ).run(session, prompt, signal),
);
const runner = new AgentRunner(
  store,
  new AiSdkGateway('full'),
  executor,
  {
    text: (delta) => event('text', { sessionId: active?.sessionId, delta }),
    notice: (message) => event('notice', { sessionId: active?.sessionId, message }),
    approve: (call: ToolCall, reason: string) =>
      new Promise<boolean>((resolve) => {
        const approvalId = randomUUID();
        approvals.set(approvalId, resolve);
        event('approval', { sessionId: active?.sessionId, approvalId, call, reason });
      }),
  },
  services,
);
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
  const events = store.events(session.id);
  return {
    session,
    events: redactEvents(events, session.profile.alias),
    plan: planState(events),
    needsReview: needsReview(session.id),
  };
}
function redactEvents(events: ReturnType<typeof store.events>, alias: string) {
  const key = getRuntimeApiKey(alias);
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const withoutCurrentKey = key ? value.replaceAll(key, '[REDACTED]') : value;
      return withoutCurrentKey.replace(
        /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,})\b/g,
        '[REDACTED]',
      );
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item)]));
    return value;
  };
  return events.map((item) => ({
    ...item,
    payload: scrub(item.payload) as Record<string, unknown>,
  }));
}
async function startRun(session: Session, prompt?: string): Promise<{ started: boolean }> {
  if (active) throw new Error('已有任务正在运行');
  if (needsReview(session.id)) throw new Error('请先检查执行结果未知的工具调用并确认继续');
  const controller = new AbortController();
  active = { sessionId: session.id, controller };
  event('runStarted', { sessionId: session.id });
  void runner
    .run(session, prompt, controller.signal)
    .then(() =>
      event('runFinished', { sessionId: session.id, events: viewSession(session).events }),
    )
    .catch((error) =>
      event('runFailed', {
        sessionId: session.id,
        message: error instanceof Error ? error.message : String(error),
        events: viewSession(session).events,
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
      const profile = findProfile(String(p.alias ?? ''));
      const modelId = p.modelId === undefined ? profile.model : String(p.modelId).trim();
      if (!modelId || modelId.length > 200 || /[\u0000-\u001f]/.test(modelId))
        throw new Error('无效的模型 ID');
      const nextProfile = { ...profile, model: modelId };
      if (JSON.stringify(session.profile) !== JSON.stringify(nextProfile))
        store.setProfile(session.id, nextProfile);
      return viewSession(getSession(session.id));
    }
    case 'discoverModels': {
      const profile = findProfile(String(p.alias ?? ''));
      return discoverModels(profile);
    }
    case 'setPlanMode': {
      if (active) throw new Error('运行中不能切换规划模式');
      const session = getSession(p.sessionId);
      setPlanMode(store, session.id, p.enabled === true);
      return viewSession(session);
    }
    case 'approvePlan': {
      if (active) throw new Error('运行中不能批准规划');
      const session = getSession(p.sessionId);
      approvePlan(store, session.id);
      return viewSession(session);
    }
    case 'setPlanProgress': {
      const session = getSession(p.sessionId);
      setPlanProgress(
        store,
        session.id,
        Number(p.index),
        String(p.status) as 'pending' | 'in_progress' | 'completed',
      );
      return viewSession(session);
    }
    case 'saveMcpServer': {
      if (active) throw new Error('请等待当前任务完成后再修改 MCP 服务器');
      const server = mcpServerSchema.parse(p);
      const config = loadConfig();
      await services.mcp.disconnect(server.name);
      config.mcpServers = config.mcpServers.filter((item) => item.name !== server.name);
      config.mcpServers.push(server);
      saveConfig(config);
      return config.mcpServers;
    }
    case 'removeMcpServer': {
      if (active) throw new Error('请等待当前任务完成后再修改 MCP 服务器');
      const name = String(p.name ?? '');
      await services.mcp.disconnect(name);
      const config = loadConfig();
      config.mcpServers = config.mcpServers.filter((item) => item.name !== name);
      saveConfig(config);
      return config.mcpServers;
    }
    case 'testMcpServer': {
      const server = loadConfig().mcpServers.find((item) => item.name === p.name);
      if (!server) throw new Error('MCP 服务器未配置');
      return services.mcp.listTools(server);
    }
    case 'saveHook': {
      if (active) throw new Error('请等待当前任务完成后再修改 Hook');
      const hook = hookSchema.parse(p);
      const config = loadConfig();
      config.hooks = config.hooks.filter((item) => item.name !== hook.name);
      config.hooks.push(hook);
      saveConfig(config);
      return config.hooks;
    }
    case 'removeHook': {
      if (active) throw new Error('请等待当前任务完成后再修改 Hook');
      const config = loadConfig();
      config.hooks = config.hooks.filter((item) => item.name !== p.name);
      saveConfig(config);
      return config.hooks;
    }
    case 'runtimeTool': {
      const session = getSession(p.sessionId);
      const name = String(p.name ?? '') as ToolCall['name'];
      if (
        ![
          'create_worktree',
          'list_worktrees',
          'remove_worktree',
          'start_background',
          'background_status',
          'cancel_background',
          'spawn_subagent',
          'subagent_status',
        ].includes(name)
      )
        throw new Error('不支持此界面操作');
      const call: ToolCall = {
        id: randomUUID(),
        name,
        input: (p.input ?? {}) as Record<string, unknown>,
      };
      if (planBlocks(call, planState(store.events(session.id))))
        throw new Error('规划模式等待用户批准计划');
      store.append(session.id, 'tool_requested', {
        callId: call.id,
        name,
        input: call.input,
        source: 'desktop',
      });
      store.append(session.id, 'tool_approved', {
        callId: call.id,
        name,
        reason: '用户从桌面界面直接执行',
      });
      store.append(session.id, 'tool_started', { callId: call.id, name });
      try {
        const result = await services.execute(call, session, new AbortController().signal);
        store.append(session.id, 'tool_finished', { callId: call.id, name, ...result });
        return result;
      } catch (error) {
        store.append(session.id, 'tool_unknown', {
          callId: call.id,
          name,
          output: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
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
      for (const session of store.listSessions()) {
        if (session.profile.alias !== alias) continue;
        const nextProfile = {
          ...profile,
          model:
            previous &&
            session.profile.model !== previous.model &&
            session.profile.provider === previous.provider &&
            session.profile.baseUrl === previous.baseUrl
              ? session.profile.model
              : profile.model,
        };
        if (JSON.stringify(session.profile) !== JSON.stringify(nextProfile))
          store.setProfile(session.id, nextProfile);
      }
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
  await services.close();
  await executor.close();
  store.close();
}
lines.on('close', () => {
  void shutdown().then(() => process.exit(0));
});
