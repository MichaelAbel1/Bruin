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
  legacyKeyWasMigrated,
  saveConfig,
  setRuntimeApiKey,
  validApiKeyEnv,
  mcpServerSchema,
  hookSchema,
} from './config.js';
import { SqliteEventStore } from './storage/event-store.js';
import { AiSdkGateway, toolSchemas } from './providers/gateway.js';
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
import { listWorkspaceEntries, readWorkspaceFile } from './core/workspace-files.js';
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
let activeRun: Promise<unknown> | undefined;
const approvals = new Map<string, (approved: boolean) => void>();
const reviewed = new Set<string>();

// Remove secrets accidentally persisted by older desktop versions from session profiles.
const startupConfig = loadConfig();
let legacyKeyExposure = legacyKeyWasMigrated();
for (const session of store.listSessions()) {
  if (store.isLeased(session.id)) continue;
  const legacyValue = session.profile.apiKeyEnv;
  if (!legacyValue || validApiKeyEnv(legacyValue)) continue;
  legacyKeyExposure = true;
  if (!getRuntimeApiKey(session.profile.alias) && looksLikeApiKey(legacyValue))
    setRuntimeApiKey(session.profile.alias, legacyValue);
  const current = startupConfig.profiles.find((p) => p.alias === session.profile.alias);
  const cleanProfile = current ?? { ...session.profile, apiKeyEnv: undefined };
  store.setProfile(session.id, cleanProfile);
}
if (legacyKeyExposure) {
  const knownKeys = startupConfig.profiles
    .map((profile) => getRuntimeApiKey(profile.alias))
    .filter((key): key is string => Boolean(key));
  store.scrubSecrets(knownKeys);
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
    tasks: store.listTasks(session.id),
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
    payload: scrub(
      Object.fromEntries(
        Object.entries(item.payload).filter(([key]) => key !== 'providerMessages'),
      ),
    ) as Record<string, unknown>,
  }));
}
async function startRun(session: Session, prompt?: string): Promise<{ started: boolean }> {
  if (active) throw new Error('已有任务正在运行');
  if (needsReview(session.id)) throw new Error('请先检查执行结果未知的工具调用并确认继续');
  const owner = randomUUID();
  store.acquireLease(session.id, owner, 30_000);
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    if (!store.renewLease(session.id, owner, 30_000)) controller.abort();
  }, 10_000);
  active = { sessionId: session.id, controller };
  event('runStarted', { sessionId: session.id });
  activeRun = runner
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
      clearInterval(heartbeat);
      store.releaseLease(session.id, owner);
      active = undefined;
      activeRun = undefined;
      for (const resolve of approvals.values()) resolve(false);
      approvals.clear();
    });
  return { started: true };
}
async function dispatch(method: string, p: Record<string, unknown>) {
  switch (method) {
    case 'restoreApiKeys': {
      const keys = p.keys;
      if (!keys || typeof keys !== 'object' || Array.isArray(keys))
        throw new Error('无效的密钥数据');
      const aliases = new Set(loadConfig().profiles.map((profile) => profile.alias));
      for (const [alias, key] of Object.entries(keys))
        if (aliases.has(alias) && typeof key === 'string') setRuntimeApiKey(alias, key);
      return { restored: true };
    }
    case 'bootstrap':
      return {
        config: loadConfig(),
        sessions: store.listSessions(),
        skills: listSkills(),
        busySessionId: active?.sessionId,
        legacyKeyExposure,
      };
    case 'listSessions':
      return store.listSessions();
    case 'listWorkspaceEntries':
      return listWorkspaceEntries(getSession(p.sessionId).workspace, String(p.path ?? ''));
    case 'readWorkspaceFile':
      return readWorkspaceFile(getSession(p.sessionId).workspace, String(p.path ?? ''));
    case 'listPreferences':
      return store.listPreferences();
    case 'deletePreference':
      store.deletePreference(String(p.id ?? ''));
      return store.listPreferences();
    case 'listTasks':
      return store.listTasks(getSession(p.sessionId).id);
    case 'syncTasks': {
      const session = getSession(p.sessionId);
      store.syncTasks(session.id);
      return store.listTasks(session.id);
    }
    case 'retryTask': {
      const session = getSession(p.sessionId);
      store.retryTask(session.id, String(p.id ?? ''));
      return store.listTasks(session.id);
    }
    case 'listCronJobs':
      return store.listCronJobs(getSession(p.sessionId).id);
    case 'createCronJob': {
      const session = getSession(p.sessionId);
      return store.createCronJob(session.id, String(p.expression ?? ''), String(p.prompt ?? ''));
    }
    case 'deleteCronJob': {
      const session = getSession(p.sessionId);
      store.deleteCronJob(session.id, String(p.id ?? ''));
      return store.listCronJobs(session.id);
    }
    case 'deleteSession': {
      const session = getSession(p.sessionId);
      if (active?.sessionId === session.id) throw new Error('运行中的会话不能删除');
      store.deleteSession(session.id);
      reviewed.delete(session.id);
      return store.listSessions();
    }
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
      const unknown = store.isLeased(session.id) ? 0 : runner.recover(session);
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
      return discoverModels(profile, p.refresh === true);
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
      const workspace =
        server.transport === 'stdio' ? getSession(p.sessionId).workspace : undefined;
      return services.mcp.listTools(server, workspace);
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
          'create_task',
          'list_tasks',
          'get_task',
          'update_task',
          'claim_task',
          'finish_task',
          'list_memory',
          'save_memory',
          'remember_preference',
          'spawn_subagent',
          'subagent_status',
        ].includes(name)
      )
        throw new Error('不支持此界面操作');
      const parsed = toolSchemas[name].inputSchema.safeParse(p.input ?? {});
      if (!parsed.success) throw new Error('工具参数不符合 schema');
      const call: ToolCall = {
        id: randomUUID(),
        name,
        input: parsed.data as Record<string, unknown>,
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
        alias.length > 80 ||
        /[\u0000-\u001f]/.test(alias) ||
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
      if (
        store
          .listSessions()
          .some((session) => session.profile.alias === alias && store.isLeased(session.id))
      )
        throw new Error('该模型关联的会话正在另一个进程中运行');
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
    case 'removeProfile': {
      if (active) throw new Error('请等待当前任务完成后再删除模型配置');
      const alias = String(p.alias ?? '');
      if (
        store
          .listSessions()
          .some((session) => session.profile.alias === alias && store.isLeased(session.id))
      )
        throw new Error('该模型关联的会话正在另一个进程中运行');
      const config = loadConfig();
      if (!config.profiles.some((profile) => profile.alias === alias))
        throw new Error('模型配置不存在');
      config.profiles = config.profiles.filter((profile) => profile.alias !== alias);
      if (config.defaultProfile === alias) config.defaultProfile = config.profiles[0]?.alias;
      saveConfig(config);
      setRuntimeApiKey(alias, undefined);
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

let scheduling = false;
async function scheduleTick() {
  if (active || scheduling) return;
  scheduling = true;
  try {
    const job = store.takeDueCronJobs(Date.now())[0];
    if (job) {
      const session = store.getSession(job.sessionId);
      if (!session) return;
      try {
        await startRun(session, job.prompt);
        await activeRun;
        const last = store.events(session.id).at(-1);
        store.markCronJob(job.id, last?.type === 'turn_completed' ? 'completed' : 'needs_review');
      } catch (error) {
        store.markCronJob(job.id, 'skipped_busy');
        event('notice', {
          sessionId: session.id,
          message: `定时任务未启动: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    for (const session of store.listSessions()) {
      if (store.isLeased(session.id) || needsReview(session.id)) continue;
      const plan = planState(store.events(session.id));
      if (plan.enabled && !plan.approved) continue;
      const task = services.claimReadyTask(session);
      if (!task) continue;
      try {
        await startRun(
          session,
          `Execute claimed task ${task.id}: ${task.title}. Respect dependencies and tool approvals. Call finish_task with this ID only after verifying the result. If blocked, report why; do not claim success.`,
        );
        await activeRun;
        services.finishClaimIfOpen(task.id);
      } catch (error) {
        services.releaseClaim(task.id);
        event('notice', {
          sessionId: session.id,
          message: `任务认领未启动: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
  } catch (error) {
    event('notice', {
      message: `调度检查失败: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    scheduling = false;
  }
}
const scheduler = setInterval(() => {
  void scheduleTick();
}, 15_000);

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
  clearInterval(scheduler);
  active?.controller.abort();
  for (const resolve of approvals.values()) resolve(false);
  approvals.clear();
  await activeRun;
  await services.close();
  await executor.close();
  store.close();
}
lines.on('close', () => {
  void shutdown().then(() => process.exit(0));
});
