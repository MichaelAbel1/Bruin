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
  updateConfig,
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
import { isAutoSafeShell } from './core/approval-policy.js';
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
  listWorkspaceEntries,
  readWorkspaceFile,
  writeWorkspaceFile,
} from './core/workspace-files.js';
import { importAttachments, loadAttachment, type AttachmentRef } from './core/attachments.js';
import { listWorkspaceChanges, readWorkspaceReview } from './core/workspace-review.js';
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
let active:
  | {
      sessionId: string;
      controller: AbortController;
      allowWorkspaceEdits: boolean;
      unattended: boolean;
    }
  | undefined;
let activeRun: Promise<unknown> | undefined;
const approvals = new Map<
  string,
  { resolve: (approved: boolean) => void; sessionId: string; call: ToolCall }
>();
const reviewedUnknownSeq = new Map<string, number>();

// Remove secrets accidentally persisted by older desktop versions from session profiles.
const startupConfig = loadConfig();
let legacyKeyExposure = legacyKeyWasMigrated();
for (const session of store.listSessions()) {
  if (store.isLeased(session.id)) continue;
  if ((session.profile.contextWindowTokens ?? 0) > 1_048_576)
    store.setProfile(session.id, { ...session.profile, contextWindowTokens: 1_048_576 });
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
const legacyKeyCandidates = Object.fromEntries(
  startupConfig.profiles.flatMap((profile) => {
    const key = getRuntimeApiKey(profile.alias);
    return key ? [[profile.alias, key]] : [];
  }),
);
let legacyKeysTaken = false;

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
    checkpoint: () => {
      const sessionId = active?.sessionId;
      if (sessionId)
        event('runCheckpoint', { sessionId, events: viewSession(getSession(sessionId)).events });
    },
    approve: (call: ToolCall, reason: string) =>
      new Promise<boolean | string>((resolve) => {
        const sessionId = active?.sessionId;
        if (!sessionId) return resolve(false);
        if (
          active?.allowWorkspaceEdits &&
          (call.name === 'write_file' || call.name === 'edit_file')
        )
          return resolve(true);
        const command = call.name === 'shell' ? String(call.input.command ?? '') : '';
        const workspace = getSession(sessionId).workspace;
        const config = loadConfig();
        if (
          command &&
          (config.approvedCommands.some(
            (rule) =>
              rule.workspace === workspace &&
              rule.command === command &&
              (!rule.sessionId || rule.sessionId === sessionId),
          ) ||
            (config.approvalMode === 'autoSafe' && isAutoSafeShell(command)))
        )
          return resolve(true);
        if (active?.unattended)
          return resolve(
            '无人值守模式：此操作没有预先授权，已拒绝。请不要重复请求；改用已授权工具或说明需要用户批准。',
          );
        const approvalId = randomUUID();
        approvals.set(approvalId, { resolve, sessionId, call });
        event('approval', { sessionId, approvalId, call, reason });
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
  const events = store.events(id);
  const lastCompleted = [...events].reverse().find((e) => e.type === 'turn_completed')?.seq ?? 0;
  const uncompletedUnknowns = events.filter(
    (e) => e.seq > lastCompleted && e.type === 'tool_unknown',
  );
  if (!uncompletedUnknowns.length) return false;
  const lastUnknownSeq = uncompletedUnknowns.at(-1)!.seq;
  const reviewedSeq = reviewedUnknownSeq.get(id) ?? -1;
  return lastUnknownSeq > reviewedSeq;
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
async function startRun(
  session: Session,
  prompt?: string,
  attachments: AttachmentRef[] = [],
  quote?: { text: string; seq: number },
  runSettings: { maxModelCalls: number; allowWorkspaceEdits: boolean; unattended: boolean } = {
    maxModelCalls: 24,
    allowWorkspaceEdits: false,
    unattended: false,
  },
): Promise<{ started: boolean }> {
  if (active) throw new Error('已有任务正在运行');
  if (needsReview(session.id)) throw new Error('请先检查执行结果未知的工具调用并确认继续');
  const owner = randomUUID();
  store.acquireLease(session.id, owner, 30_000);
  try {
    store.append(session.id, 'run_configured', runSettings);
  } catch (error) {
    store.releaseLease(session.id, owner);
    throw error;
  }
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    if (!store.renewLease(session.id, owner, 30_000)) controller.abort();
  }, 10_000);
  heartbeat.unref();
  active = {
    sessionId: session.id,
    controller,
    allowWorkspaceEdits: runSettings.allowWorkspaceEdits,
    unattended: runSettings.unattended,
  };
  event('runStarted', { sessionId: session.id, longRun: runSettings.maxModelCalls > 24 });
  activeRun = runner
    .run(session, prompt, controller.signal, attachments, quote, {
      ...(runSettings.maxModelCalls > 24
        ? {
            maxModelCalls: runSettings.maxModelCalls,
            maxDurationMs: 8 * 60 * 60 * 1000,
            checkpointEvery: 24,
            unattended: runSettings.unattended,
          }
        : {}),
    })
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
      for (const pending of approvals.values()) pending.resolve(false);
      approvals.clear();
    });
  return { started: true };
}
function requestedRunSettings(p: Record<string, unknown>) {
  const maxModelCalls = p.maxModelCalls === undefined ? 24 : Number(p.maxModelCalls);
  const allowWorkspaceEdits = p.allowWorkspaceEdits === true;
  const unattended = p.unattended === true;
  if (![24, 96, 240, 480].includes(maxModelCalls)) throw new Error('无效的长任务调用预算');
  if (allowWorkspaceEdits && maxModelCalls === 24)
    throw new Error('自动修改工作区文件只能在长任务模式下启用');
  if (unattended && maxModelCalls === 24) throw new Error('无人值守模式只能在长任务模式下启用');
  if (maxModelCalls === 480 && !unattended) throw new Error('480 次模型调用需要启用无人值守模式');
  return { maxModelCalls, allowWorkspaceEdits, unattended };
}
async function dispatch(method: string, p: Record<string, unknown>) {
  switch (method) {
    case 'takeLegacyKeys': {
      if (legacyKeysTaken) return {};
      legacyKeysTaken = true;
      return legacyKeyCandidates;
    }
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
    case 'listWorkspaceEntries': {
      const session = getSession(p.sessionId);
      const relative = String(p.path ?? '');
      if (!fs.existsSync(session.workspace)) return [];
      return listWorkspaceEntries(session.workspace, relative);
    }
    case 'listWorkspaceChanges': {
      const session = getSession(p.sessionId);
      return listWorkspaceChanges(session.workspace, store.events(session.id));
    }
    case 'readWorkspaceReview': {
      const session = getSession(p.sessionId);
      return readWorkspaceReview(session.workspace, String(p.path ?? ''), store.events(session.id));
    }
    case 'readWorkspaceFile': {
      const session = getSession(p.sessionId);
      if (!fs.existsSync(session.workspace)) {
        throw new Error('文件不存在');
      }
      return readWorkspaceFile(session.workspace, String(p.path ?? ''));
    }
    case 'writeWorkspaceFile': {
      const session = getSession(p.sessionId);
      if (active?.sessionId === session.id)
        throw new Error('当前会话正在运行任务，请等待完成后再修改文件');
      const leaseOwner = randomUUID();
      store.acquireLease(session.id, leaseOwner, 10_000);
      try {
        if (session.managedWorkspace && !fs.existsSync(session.workspace)) {
          store.materializeWorkspace(session.id);
        }
        return writeWorkspaceFile(
          session.workspace,
          String(p.path ?? ''),
          String(p.content ?? ''),
          typeof p.expectedContent === 'string' ? p.expectedContent : undefined,
        );
      } finally {
        store.releaseLease(session.id, leaseOwner);
      }
    }
    case 'importAttachments': {
      const session = getSession(p.sessionId);
      if (!Array.isArray(p.paths) || p.paths.some((item) => typeof item !== 'string'))
        throw new Error('附件路径无效');
      return importAttachments(session.id, p.paths as string[]);
    }
    case 'listPreferences':
      return store.listPreferences();
    case 'deletePreference':
      store.deletePreference(String(p.id ?? ''));
      return store.listPreferences();
    case 'listTasks':
      return store.listTasks(getSession(p.sessionId).id);
    case 'syncTasks': {
      const session = getSession(p.sessionId);
      if (session.managedWorkspace && !fs.existsSync(session.workspace)) {
        store.materializeWorkspace(session.id);
      }
      if (!fs.existsSync(session.workspace)) return [];
      store.syncTasks(session.id);
      return store.listTasks(session.id);
    }
    case 'retryTask': {
      const session = getSession(p.sessionId);
      store.retryTask(session.id, String(p.id ?? ''));
      return store.listTasks(session.id);
    }
    case 'deleteTask': {
      const session = getSession(p.sessionId);
      store.deleteTask(session.id, String(p.id ?? ''));
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
      updateConfig((config) => ({
        ...config,
        approvedCommands: config.approvedCommands.filter((rule) => rule.sessionId !== session.id),
      }));
      reviewedUnknownSeq.delete(session.id);
      return store.listSessions();
    }
    case 'createSession': {
      const alias =
        typeof p.profileAlias === 'string' && p.profileAlias ? p.profileAlias : undefined;
      const profile = findProfile(alias);
      const selected = String(p.workspace ?? '').trim();
      if (selected) {
        const workspace = fs.realpathSync(selected);
        if (!fs.statSync(workspace).isDirectory()) throw new Error('工作区必须是目录');
        return viewSession(store.createSession(workspace, profile));
      }
      const date = new Date().toISOString();
      const name = `${date.slice(0, 10).replaceAll('-', '')}-${date.slice(11, 19).replaceAll(':', '')}-${randomUUID().slice(0, 8)}`;
      return viewSession(
        store.createManagedSession(
          path.join(fs.realpathSync(dataDir()), 'workspaces', name),
          profile,
        ),
      );
    }
    case 'setWorkspace': {
      if (active) throw new Error('请等待当前任务完成后再更换工作区');
      const session = getSession(p.sessionId);
      store.setWorkspace(session.id, String(p.workspace ?? ''));
      return viewSession(getSession(session.id));
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
      const events = store.events(session.id);
      const lastCompleted =
        [...events].reverse().find((e) => e.type === 'turn_completed')?.seq ?? 0;
      const lastUnknown = events
        .filter((e) => e.seq > lastCompleted && e.type === 'tool_unknown')
        .at(-1);
      if (lastUnknown) reviewedUnknownSeq.set(session.id, lastUnknown.seq);
      return viewSession(session);
    }
    case 'send': {
      const prompt = String(p.prompt ?? '').trim();
      const session = getSession(p.sessionId);
      const attachments = Array.isArray(p.attachments) ? p.attachments : [];
      if (attachments.length > 30 || attachments.some((item) => typeof item !== 'string'))
        throw new Error('附件列表无效');
      const refs = attachments.map((id) => loadAttachment(session.id, String(id)).ref);
      const quoteSeq = Number(p.quoteSeq);
      const source = Number.isInteger(quoteSeq)
        ? store
            .events(session.id)
            .find((item) => item.seq === quoteSeq && ['user', 'assistant'].includes(item.type))
        : undefined;
      const quote = source
        ? { seq: source.seq, text: String(source.payload.text ?? '').slice(0, 4000) }
        : undefined;
      if (!prompt && !refs.length && !quote) throw new Error('消息不能为空');
      return startRun(session, prompt, refs, quote, requestedRunSettings(p));
    }
    case 'resume':
      return startRun(getSession(p.sessionId), undefined, [], undefined, requestedRunSettings(p));
    case 'finishPausedTurn': {
      if (active) throw new Error('请等待当前任务结束');
      const session = getSession(p.sessionId);
      const leaseOwner = randomUUID();
      store.acquireLease(session.id, leaseOwner, 10_000);
      try {
        if (store.events(session.id).at(-1)?.type !== 'turn_paused')
          throw new Error('当前任务未处于暂停状态');
        store.append(session.id, 'turn_completed', { stoppedByUser: true });
        return viewSession(session);
      } finally {
        store.releaseLease(session.id, leaseOwner);
      }
    }
    case 'cancel': {
      if (!active || active.sessionId !== String(p.sessionId)) return { cancelled: false };
      active.controller.abort();
      for (const pending of approvals.values()) pending.resolve(false);
      approvals.clear();
      return { cancelled: true };
    }
    case 'answerApproval': {
      const id = String(p.approvalId ?? '');
      const pending = approvals.get(id);
      if (!pending) throw new Error('审批请求已失效');
      const scope = String(p.scope ?? 'once');
      if (!['once', 'session', 'always'].includes(scope)) throw new Error('无效的授权范围');
      if (p.approved === true && scope !== 'once') {
        if (pending.call.name !== 'shell' || typeof pending.call.input.command !== 'string')
          throw new Error('仅 Shell 命令支持记住授权');
        const workspace = getSession(pending.sessionId).workspace;
        const command = pending.call.input.command;
        const sessionId = scope === 'session' ? pending.sessionId : undefined;
        updateConfig((config) => {
          if (
            !config.approvedCommands.some(
              (rule) =>
                rule.workspace === workspace &&
                rule.command === command &&
                rule.sessionId === sessionId,
            )
          )
            config.approvedCommands.push({
              workspace,
              command,
              ...(sessionId ? { sessionId } : {}),
            });
          return config;
        });
      }
      approvals.delete(id);
      pending.resolve(p.approved === true);
      return { accepted: true };
    }
    case 'getApprovalSettings': {
      const sessionId = String(p.sessionId ?? '');
      const config = loadConfig();
      return {
        config,
        sessionCommands: config.approvedCommands
          .filter((rule) => rule.sessionId === sessionId)
          .map((rule) => [rule.workspace, rule.command]),
      };
    }
    case 'removeSessionCommand': {
      const sessionId = String(p.sessionId ?? '');
      const workspace = String(p.workspace ?? '');
      const command = String(p.command ?? '');
      updateConfig((config) => ({
        ...config,
        approvedCommands: config.approvedCommands.filter(
          (rule) =>
            rule.sessionId !== sessionId ||
            rule.workspace !== workspace ||
            rule.command !== command,
        ),
      }));
      return { removed: true };
    }
    case 'setApprovalMode': {
      const mode = String(p.mode ?? '');
      if (mode !== 'ask' && mode !== 'autoSafe') throw new Error('无效的审批模式');
      return updateConfig((config) => ({ ...config, approvalMode: mode }));
    }
    case 'removeApprovedCommand': {
      const workspace = String(p.workspace ?? '');
      const command = String(p.command ?? '');
      return updateConfig((config) => ({
        ...config,
        approvedCommands: config.approvedCommands.filter(
          (rule) => rule.sessionId || rule.workspace !== workspace || rule.command !== command,
        ),
      }));
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
      await services.mcp.logout(server.name);
      const config = updateConfig((current) => {
        current.mcpServers = current.mcpServers.filter((item) => item.name !== server.name);
        current.mcpServers.push(server);
        return current;
      });
      return config.mcpServers;
    }
    case 'removeMcpServer': {
      if (active) throw new Error('请等待当前任务完成后再修改 MCP 服务器');
      const name = String(p.name ?? '');
      await services.mcp.logout(name);
      const config = updateConfig((current) => {
        current.mcpServers = current.mcpServers.filter((item) => item.name !== name);
        return current;
      });
      return config.mcpServers;
    }
    case 'testMcpServer': {
      const server = loadConfig().mcpServers.find((item) => item.name === p.name);
      if (!server) throw new Error('MCP 服务器未配置');
      const workspace =
        server.transport === 'stdio' ? getSession(p.sessionId).workspace : undefined;
      return services.mcp.listTools(server, workspace);
    }
    case 'loginMcpServer': {
      if (active) throw new Error('请等待当前任务完成后登录 MCP');
      const server = loadConfig().mcpServers.find((item) => item.name === p.name);
      if (!server) throw new Error('MCP 服务器未配置');
      await services.mcp.login(server, async (url) => {
        event('openOAuthBrowser', { url });
      });
      return { message: 'OAuth 登录成功（本次运行有效）' };
    }
    case 'logoutMcpServer': {
      if (active) throw new Error('请等待当前任务完成后退出 MCP');
      await services.mcp.logout(String(p.name ?? ''));
      return { message: '已清除本机 OAuth 会话；未撤销服务端授权' };
    }
    case 'cancelMcpLogin': {
      services.mcp.cancelLogin(String(p.name ?? ''));
      return null;
    }
    case 'saveHook': {
      if (active) throw new Error('请等待当前任务完成后再修改 Hook');
      const hook = hookSchema.parse(p);
      const config = updateConfig((current) => {
        current.hooks = current.hooks.filter((item) => item.name !== hook.name);
        current.hooks.push(hook);
        return current;
      });
      return config.hooks;
    }
    case 'removeHook': {
      if (active) throw new Error('请等待当前任务完成后再修改 Hook');
      const config = updateConfig((current) => {
        current.hooks = current.hooks.filter((item) => item.name !== p.name);
        return current;
      });
      return config.hooks;
    }
    case 'runtimeTool': {
      const session = getSession(p.sessionId);
      if (active?.sessionId === session.id)
        throw new Error('当前会话正在运行任务，请等待完成后再执行操作');
      if (store.isLeased(session.id)) throw new Error('此会话正在运行，请等待完成后再执行操作');
      const name = String(p.name ?? '') as ToolCall['name'];
      if (
        ![
          'search_repository',
          'list_snapshots',
          'restore_snapshot',
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
        if (
          ['create_task', 'update_task', 'start_background'].includes(name) &&
          session.managedWorkspace &&
          !fs.existsSync(session.workspace)
        ) {
          store.materializeWorkspace(session.id);
        }
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
      if (baseUrl) {
        try {
          const u = new URL(baseUrl);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
        } catch {
          throw new Error('Base URL 必须是以 http:// 或 https:// 开头的有效网址');
        }
      }
      const apiKeyEnv = String(p.apiKeyEnv ?? '').trim() || undefined;
      const existingProfile = loadConfig().profiles.find((item) => item.alias === alias);
      const contextWindowTokens = Number(
        p.contextWindowTokens ?? existingProfile?.contextWindowTokens ?? 32_768,
      );
      if (
        !Number.isInteger(contextWindowTokens) ||
        contextWindowTokens < 8192 ||
        contextWindowTokens > 1_048_576
      )
        throw new Error('上下文窗口须为 8192 到 1048576 之间的整数');
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
        contextWindowTokens,
      };
      if (
        store
          .listSessions()
          .some((session) => session.profile.alias === alias && store.isLeased(session.id))
      )
        throw new Error('该模型关联的会话正在另一个进程中运行');
      let previous: ModelProfile | undefined;
      const config = updateConfig((current) => {
        previous = current.profiles.find((x) => x.alias === alias);
        current.profiles = current.profiles.filter((x) => x.alias !== alias);
        current.profiles.push(profile);
        current.defaultProfile ??= alias;
        return current;
      });
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
      return config;
    }
    case 'setDefaultModel': {
      const alias = String(p.alias ?? '');
      return updateConfig((config) => {
        if (!config.profiles.some((x) => x.alias === alias)) throw new Error('模型配置不存在');
        config.defaultProfile = alias;
        return config;
      });
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
      const config = updateConfig((current) => {
        if (!current.profiles.some((profile) => profile.alias === alias))
          throw new Error('模型配置不存在');
        current.profiles = current.profiles.filter((profile) => profile.alias !== alias);
        if (current.defaultProfile === alias) current.defaultProfile = current.profiles[0]?.alias;
        return current;
      });
      setRuntimeApiKey(alias, undefined);
      return config;
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
      if (!session) {
        store.markCronJob(job.id, 'session_missing');
        return;
      }
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
scheduler.unref();

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
    if (!request || typeof request !== 'object' || typeof request.method !== 'string') return;
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
  for (const pending of approvals.values()) pending.resolve(false);
  approvals.clear();
  await activeRun;
  await services.close();
  await executor.close();
  store.close();
}
let shuttingDown = false;
async function safeShutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await shutdown();
  } catch (err) {
    process.stderr.write(`Shutdown error: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(code);
  }
}
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') void safeShutdown(0);
});
lines.on('close', () => {
  void safeShutdown(0);
});
process.on('SIGINT', () => {
  void safeShutdown(0);
});
process.on('SIGTERM', () => {
  void safeShutdown(0);
});
