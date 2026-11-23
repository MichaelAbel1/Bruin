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
import { SqliteEventStore, type CronJob, type MemoryPage } from './storage/event-store.js';
import { AiSdkGateway, proposeMemory, resolveApiKey, toolSchemas } from './providers/gateway.js';
import { discoverModels } from './providers/catalog.js';
import { ProcessExecutor } from './executor/client.js';
import { AgentRunner, formatModelError } from './core/agent.js';
import { memoryContext } from './core/memory.js';
import {
  memoryCandidateSchema,
  memoryReviewEvidence,
  memoryReviewTurns,
  type MemoryCandidatePreview,
  type MemoryReviewPreview,
} from './core/memory-review.js';
import { enqueueInput } from './core/input-queue.js';
import { isAutoSafeShell, isMaliciousShell } from './core/approval-policy.js';
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
import { createSubagentRunner } from './runtime/subagent.js';
import { turnState } from './core/turn-state.js';
import { pendingQuestion, recordQuestionAnswer } from './core/question.js';
import { cronPlan, recoverCronJobs } from './runtime/cron.js';
import { needsUnknownReview, recordUnknownReview } from './core/unknown-review.js';
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
let activeRun: Promise<boolean> | undefined;
let memoryReviewRun:
  { controller: AbortController; result: Promise<MemoryReviewPreview> } | undefined;
let memoryReview:
  | {
      id: string;
      sessionId: string;
      workspace: string;
      endSeq: number;
      candidates: Map<string, { content: string; base: MemoryPage | null }>;
    }
  | undefined;
const approvals = new Map<
  string,
  { resolve: (approved: boolean) => void; sessionId: string; call: ToolCall }
>();

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

const services = new RuntimeServices(store, executor, createSubagentRunner(store, executor));
services.mcp.onCredentials = (name, signature, state) => {
  if (process.env.BRUIN_SERVICE !== '1') event('oauthCredentials', { name, signature, state });
};
const runner = new AgentRunner(
  store,
  new AiSdkGateway('full', true),
  executor,
  {
    text: (delta) => event('text', { sessionId: active?.sessionId, delta }),
    notice: (message) => event('notice', { sessionId: active?.sessionId, message }),
    inputConsumed: () => {
      const sessionId = active?.sessionId;
      if (sessionId)
        event('queueUpdated', { sessionId, events: viewSession(getSession(sessionId)).events });
    },
    checkpoint: () => {
      const sessionId = active?.sessionId;
      if (sessionId)
        event('runCheckpoint', { sessionId, events: viewSession(getSession(sessionId)).events });
    },
    approve: (call: ToolCall, reason: string, signal: AbortSignal) =>
      new Promise<boolean | string>((resolve) => {
        const sessionId = active?.sessionId;
        if (!sessionId || signal.aborted) return resolve(false);
        if (
          active?.allowWorkspaceEdits &&
          (call.name === 'write_file' || call.name === 'edit_file')
        )
          return resolve(true);
        const command =
          (call.name === 'shell' || call.name === 'start_background') &&
          typeof call.input.command === 'string'
            ? call.input.command
            : '';
        const workspace = getSession(sessionId).workspace;
        const config = loadConfig();
        if (config.approvalMode === 'auto') {
          if (call.name === 'shell' || call.name === 'start_background') {
            if (!isMaliciousShell(command)) return resolve(true);
          } else {
            return resolve(true);
          }
        }
        if (
          command &&
          !isMaliciousShell(command) &&
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
        const finish = (approved: boolean) => {
          signal.removeEventListener('abort', abort);
          approvals.delete(approvalId);
          resolve(approved);
        };
        const abort = () => finish(false);
        approvals.set(approvalId, { resolve: finish, sessionId, call });
        signal.addEventListener('abort', abort, { once: true });
        event('approval', { sessionId, workspace, approvalId, call, reason });
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
  return needsUnknownReview(store.events(id));
}
function viewSession(session: Session) {
  const events = store.events(session.id);
  return {
    session,
    events: redactEvents(events, session.profile.alias),
    plan: planState(events),
    tasks: store.listTasks(session.id),
    needsReview: needsUnknownReview(events),
  };
}
function redactApiKeys(text: string, key?: string) {
  return (key ? text.replaceAll(key, '[REDACTED]') : text).replace(
    /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,})\b/g,
    '[REDACTED]',
  );
}
function redactEvents(events: ReturnType<typeof store.events>, alias: string) {
  const key = getRuntimeApiKey(alias);
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return redactApiKeys(value, key);
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

async function previewMemoryReview(session: Session, endSeq: unknown, signal: AbortSignal) {
  const events = store.events(session.id);
  const turn = memoryReviewTurns(events).find((item) => item.endSeq === endSeq);
  if (!turn) throw new Error('请选择当前工作区内已结束的回合');
  const key = resolveApiKey(session.profile);
  const redact = (text: string) =>
    redactApiKeys(text, key)
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
      .replace(
        /\b([\w.-]*(?:password|passphrase|api[_-]?key|secret|token|credential|private[_-]?key)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
        '$1[REDACTED]',
      );
  const evidence = memoryReviewEvidence(events, turn, redact);
  const id = randomUUID();
  if (!evidence.length) return { id, candidates: [] };
  const pages = store.listMemory(session.workspace);
  const source = JSON.stringify({
    evidence,
    existingMemory: memoryContext(
      pages.map((page) => ({ ...page, key: redact(page.key), content: redact(page.content) })),
      evidence.map((item) => item.text).join('\n'),
      2000,
    ),
  });
  let reply: string;
  try {
    reply = await proposeMemory(session.profile, source, signal);
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw new Error('整理请求已取消或超时');
    throw new Error(`生成记忆候选失败：${redact(formatModelError(error))}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1'));
  } catch {
    throw new Error('模型未返回有效的记忆候选，请重新生成');
  }
  const proposals = memoryCandidateSchema.safeParse(parsed);
  if (!proposals.success) throw new Error('模型未返回有效的记忆候选，请重新生成');
  const candidates: MemoryCandidatePreview[] = [];
  const pending: NonNullable<typeof memoryReview>['candidates'] = new Map();
  for (const proposal of proposals.data) {
    const referenced = [...new Set(proposal.evidenceSeqs)].map((seq) =>
      evidence.find((item) => item.seq === seq),
    );
    if (referenced.some((item) => !item) || pending.has(proposal.key))
      throw new Error('模型返回了重复候选或处于回合之外的证据，请重新生成');
    const content = redact(proposal.content);
    if (content.includes('[REDACTED]') || redactApiKeys(proposal.key, key) !== proposal.key)
      continue;
    const base = pages.find((page) => page.key === proposal.key) ?? null;
    const sources = referenced.filter((item) => item !== undefined);
    candidates.push({
      key: proposal.key,
      content,
      previousContent: base ? redact(base.content) : undefined,
      evidence: sources,
    });
    pending.set(proposal.key, {
      base,
      content: `${content}\n\n来源会话 ${session.id} · 事件 ${sources.map((item) => `#${item.seq}`).join('、')}`,
    });
  }
  memoryReview = {
    id,
    sessionId: session.id,
    workspace: session.workspace,
    endSeq: turn.endSeq,
    candidates: pending,
  };
  return { id, candidates };
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
  answer?: { id: string; text: string },
): Promise<{ started: boolean }> {
  if (active) throw new Error('已有任务正在运行');
  if (needsReview(session.id)) throw new Error('请先检查执行结果未知的工具调用并确认继续');
  const controller = new AbortController();
  const lease = services.sessionLeases.retain(session.id, controller);
  try {
    runner.recover(session);
    if (needsReview(session.id)) throw new Error('请先检查执行结果未知的工具调用并确认继续');
    if (answer) recordQuestionAnswer(store, session.id, answer.id, answer.text);
    else if (pendingQuestion(store.events(session.id))) throw new Error('请先答复当前待答问题');
    store.append(session.id, 'run_configured', runSettings);
  } catch (error) {
    lease.release();
    throw error;
  }
  active = {
    sessionId: session.id,
    controller,
    allowWorkspaceEdits: runSettings.allowWorkspaceEdits,
    unattended: runSettings.unattended,
  };
  event('runStarted', { sessionId: session.id, longRun: runSettings.maxModelCalls > 24 });
  activeRun = runner
    .run(session, prompt, controller.signal, attachments, quote, {
      allowWorkspaceEdits: runSettings.allowWorkspaceEdits,
      allowQuestions: true,
      ...(runSettings.maxModelCalls > 24
        ? {
            maxModelCalls: runSettings.maxModelCalls,
            maxDurationMs: 8 * 60 * 60 * 1000,
            checkpointEvery: 24,
            unattended: runSettings.unattended,
          }
        : {}),
    })
    .then(() => {
      event('runFinished', { sessionId: session.id, events: viewSession(session).events });
      return true;
    })
    .catch((error) => {
      event('runFailed', {
        sessionId: session.id,
        message: error instanceof Error ? error.message : String(error),
        events: viewSession(session).events,
      });
      return false;
    })
    .finally(() => {
      try {
        lease.release();
      } finally {
        active = undefined;
        activeRun = undefined;
        for (const pending of approvals.values()) pending.resolve(false);
        approvals.clear();
      }
    })
    .catch(() => {
      event('runFailed', { sessionId: session.id, message: '运行收尾失败，请检查数据库状态' });
      return false;
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
    case 'restoreMcpCredentials': {
      if (active) throw new Error('运行中不能恢复凭证');
      const server = loadConfig().mcpServers.find((server) => server.name === p.name);
      if (server) services.mcp.restoreOAuth(server, String(p.signature ?? ''), p.state);
      return { restored: true };
    }
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
    case 'previewMemoryReview': {
      const session = getSession(p.sessionId);
      if (memoryReviewRun) throw new Error('正在生成记忆候选');
      if (active?.sessionId === session.id || store.isLeased(session.id))
        throw new Error('请等待当前会话结束后再整理记忆');
      memoryReview = undefined;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
      const result = previewMemoryReview(session, p.endSeq, signal);
      memoryReviewRun = { controller, result };
      try {
        return await result;
      } finally {
        memoryReviewRun = undefined;
      }
    }
    case 'discardMemoryReview':
      if (memoryReview && memoryReview.id === p.reviewId && memoryReview.sessionId === p.sessionId)
        memoryReview = undefined;
      return { discarded: true };
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
      const expression = String(p.expression ?? '');
      const prompt = String(p.prompt ?? '');
      const planSeq = p.planSeq;
      if (planSeq === undefined) return store.createCronJob(session.id, expression, prompt);
      if (typeof planSeq !== 'number' || !Number.isSafeInteger(planSeq) || planSeq < 1)
        throw new Error('无效的计划版本');
      const lease = services.sessionLeases.retain(session.id, new AbortController());
      try {
        if (!cronPlan(store.events(session.id), planSeq))
          throw new Error('该计划版本已变更或尚未批准，请重新选择');
        return store.createCronJob(session.id, expression, prompt, planSeq);
      } finally {
        lease.release();
      }
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
      return store.listSessions();
    }
    case 'createSession': {
      if (active) throw new Error('请等待当前任务完成后再新建会话');
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
      fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
      const managedRoot = fs.existsSync(dataDir()) ? fs.realpathSync(dataDir()) : dataDir();
      return viewSession(
        store.createManagedSession(path.join(managedRoot, 'workspaces', name), profile),
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
      let unknown = 0;
      if (!store.isLeased(session.id)) {
        const lease = services.sessionLeases.retain(session.id, new AbortController());
        try {
          unknown = runner.recover(session);
        } finally {
          lease.release();
        }
      }
      return { ...viewSession(session), recoveredUnknown: unknown };
    }
    case 'reviewUnknown': {
      const session = getSession(p.sessionId);
      const owner = randomUUID();
      store.acquireLease(session.id, owner, 10_000);
      try {
        recordUnknownReview(store, session.id, p.throughSeq, 'desktop');
        return viewSession(session);
      } finally {
        store.releaseLease(session.id, owner);
      }
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
      if (p.delivery !== undefined && !['steer', 'follow-up'].includes(String(p.delivery)))
        throw new Error('无效的消息投递方式');
      if (active && p.delivery !== undefined) {
        if (active.sessionId !== session.id) throw new Error('请等待其他会话的任务完成');
        const lease = services.sessionLeases.retain(session.id, active.controller);
        try {
          enqueueInput(store, session.id, {
            id: randomUUID(),
            mode: p.delivery as 'steer' | 'follow-up',
            text: prompt,
            attachments: refs,
            ...(quote ? { quote } : {}),
          });
          return { queued: true, events: viewSession(session).events };
        } finally {
          lease.release();
        }
      }
      return startRun(session, prompt, refs, quote, requestedRunSettings(p));
    }
    case 'resume':
      return startRun(getSession(p.sessionId), undefined, [], undefined, requestedRunSettings(p));
    case 'answerQuestion': {
      if (typeof p.questionId !== 'string' || typeof p.text !== 'string')
        throw new Error('无效的问题答复');
      return startRun(getSession(p.sessionId), undefined, [], undefined, requestedRunSettings(p), {
        id: p.questionId,
        text: p.text,
      });
    }
    case 'finishPausedTurn': {
      if (active) throw new Error('请等待当前任务结束');
      const session = getSession(p.sessionId);
      const leaseOwner = randomUUID();
      store.acquireLease(session.id, leaseOwner, 10_000);
      try {
        const events = store.events(session.id);
        if (turnState(events) !== 'paused' && !pendingQuestion(events))
          throw new Error('当前任务未处于暂停状态');
        if (needsReview(session.id)) throw new Error('请先检查执行结果未知的工具调用并确认');
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
        if (isMaliciousShell(command)) throw new Error('高危破坏性命令不支持记住授权');
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
      if (mode !== 'ask' && mode !== 'autoSafe' && mode !== 'auto')
        throw new Error('无效的审批模式');
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
      return { message: 'OAuth 登录成功' };
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
    case 'prepareSubagentPatch': {
      const session = getSession(p.sessionId);
      return services.exportSubagentPatch(session.id, String(p.childId ?? ''));
    }
    case 'listSubagentPatches':
      return services.listSubagentPatches(getSession(p.sessionId).id);
    case 'preflightSubagentPatches': {
      const session = getSession(p.sessionId);
      if (!Array.isArray(p.childIds) || p.childIds.some((id) => typeof id !== 'string'))
        throw new Error('子任务列表无效');
      const testCommand = p.testCommand;
      if (
        testCommand !== undefined &&
        (typeof testCommand !== 'string' || !testCommand.trim() || testCommand.length > 10_000)
      )
        throw new Error('测试命令须为 1 至 10,000 字符的非空文本');
      return services.preflightSubagentPatches(session, p.childIds, testCommand);
    }
    case 'confirmMemoryCandidate':
    case 'runtimeTool': {
      const session = getSession(p.sessionId);
      const review = method === 'confirmMemoryCandidate' ? memoryReview : undefined;
      const key = String(p.key ?? '');
      const candidate = review?.candidates.get(key);
      if (
        method === 'confirmMemoryCandidate' &&
        (!review ||
          !candidate ||
          review.id !== p.reviewId ||
          review.sessionId !== session.id ||
          review.workspace !== session.workspace)
      )
        throw new Error('候选已失效，请在当前会话重新生成');
      const name = candidate ? 'save_memory' : (String(p.name ?? '') as ToolCall['name']);
      const control = [
        'subagent_status',
        'subagent_review',
        'cancel_subagent',
        'background_status',
        'cancel_background',
      ].includes(name);
      if (!control && active?.sessionId === session.id)
        throw new Error('当前会话正在运行任务，请等待完成后再执行操作');
      if (
        !control &&
        store.isLeased(session.id) &&
        !(name === 'spawn_subagent' && services.sessionLeases.hasLocalLease(session.id))
      )
        throw new Error('此会话正在运行，请等待完成后再执行操作');
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
          'subagent_review',
          'cancel_subagent',
        ].includes(name)
      )
        throw new Error('不支持此界面操作');
      const input = candidate ? { key, content: candidate.content } : (p.input ?? {});
      const parsed = toolSchemas[name].inputSchema.safeParse(input);
      if (!parsed.success) throw new Error('工具参数不符合 schema');
      const call: ToolCall = {
        id: randomUUID(),
        name,
        input: parsed.data as Record<string, unknown>,
      };
      const controller = new AbortController();
      const lease =
        name === 'spawn_subagent' || candidate
          ? services.sessionLeases.retain(session.id, controller)
          : undefined;
      try {
        const events = store.events(session.id);
        if (
          review &&
          (getSession(session.id).workspace !== review.workspace ||
            !memoryReviewTurns(events).some((turn) => turn.endSeq === review.endSeq))
        )
          throw new Error('候选已失效，请在当前会话重新生成');
        if (planBlocks(call, planState(events))) throw new Error('规划模式等待用户批准计划');
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
        const toolStarted = store.append(session.id, 'tool_started', { callId: call.id, name });
        try {
          if (
            ['create_task', 'update_task', 'start_background'].includes(name) &&
            session.managedWorkspace &&
            !fs.existsSync(session.workspace)
          ) {
            store.materializeWorkspace(session.id);
          }
          const result = await services.execute(call, session, controller.signal, {
            toolStartedSeq: toolStarted.seq,
            allowWorkspaceEdits: p.allowWorkspaceEdits === true,
            expectedMemoryPage: candidate?.base,
          });
          store.append(session.id, 'tool_finished', { callId: call.id, name, ...result });
          if (!result.isError) review?.candidates.delete(key);
          return result;
        } catch (error) {
          store.append(session.id, 'tool_unknown', {
            callId: call.id,
            name,
            output: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      } finally {
        lease?.release();
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

async function runScheduledCron(job: CronJob) {
  const session = store.getSession(job.sessionId);
  if (!session) {
    store.markCronJob(job.id, 'session_missing');
    return;
  }
  const controller = new AbortController();
  let lease: ReturnType<typeof services.sessionLeases.retain> | undefined;
  try {
    let throughSeq = 0;
    let planUnavailable = false;
    try {
      // The runner retains its own reference. Keep this one until the job receipt is durable.
      lease = services.sessionLeases.retain(session.id, controller);
      const events = store.events(session.id);
      throughSeq = events.at(-1)?.seq ?? 0;
      planUnavailable = job.planSeq !== undefined && !cronPlan(events, job.planSeq);
      if (!planUnavailable)
        await startRun(session, job.prompt, [], undefined, {
          maxModelCalls: 24,
          allowWorkspaceEdits: false,
          unattended: process.env.BRUIN_SERVICE === '1',
        });
    } catch (error) {
      if (
        !controller.signal.aborted &&
        (!lease || store.renewLease(session.id, lease.owner, 30_000))
      )
        store.markCronJob(job.id, needsReview(session.id) ? 'needs_review' : 'skipped_busy');
      event('notice', {
        sessionId: session.id,
        message: `定时任务未启动: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const unavailableDetail = `关联的计划版本 #${job.planSeq} 已变更、停用或未获批准`;
    if (planUnavailable) {
      if (!controller.signal.aborted && store.renewLease(session.id, lease.owner, 30_000)) {
        store.markCronJob(job.id, 'needs_review', unavailableDetail);
        event('notice', { sessionId: session.id, message: unavailableDetail });
      }
      return;
    }
    const succeeded = await activeRun;
    const events = store.events(session.id);
    const runEvents = events.filter((event) => event.seq > throughSeq);
    const failedHook = runEvents.some(
      (event) => event.type === 'hook_finished' && event.payload.isError,
    );
    if (controller.signal.aborted || !store.renewLease(session.id, lease.owner, 30_000)) return;
    let detail: string | undefined;
    if (job.planSeq !== undefined) {
      const plan = cronPlan(events, job.planSeq);
      if (!plan) detail = unavailableDetail;
      else {
        const pending = plan.steps.filter((_step, index) => plan.progress[index] !== 'completed');
        if (pending.length)
          detail = `关联的计划版本 #${job.planSeq} 还有未完成步骤：${pending.join('、')}`;
      }
    }
    store.markCronJob(
      job.id,
      succeeded === true && turnState(runEvents) === 'completed' && !failedHook && !detail
        ? 'completed'
        : 'needs_review',
      detail,
    );
    if (detail) event('notice', { sessionId: session.id, message: detail });
  } finally {
    lease?.release();
  }
}

let scheduled: Promise<void> | undefined;
let shuttingDown = false;
async function scheduleTick() {
  try {
    recoverCronJobs(store);
    const job = store.takeDueCronJobs(Date.now())[0];
    if (job) {
      await runScheduledCron(job);
      return;
    }
    for (const session of store.listSessions()) {
      if (store.isLeased(session.id) || needsReview(session.id)) continue;
      const events = store.events(session.id);
      if (pendingQuestion(events)) continue;
      const plan = planState(events);
      if (plan.enabled && !plan.approved) continue;
      const task = services.claimReadyTask(session);
      if (!task) continue;
      try {
        await startRun(
          session,
          `Execute claimed task ${task.id}: ${task.title}. Respect dependencies and tool approvals. Call finish_task with this ID only after verifying the result. If blocked, report why; do not claim success.`,
          [],
          undefined,
          {
            maxModelCalls: 24,
            allowWorkspaceEdits: false,
            unattended: process.env.BRUIN_SERVICE === '1',
          },
        );
      } catch (error) {
        services.releaseClaim(task.id);
        event('notice', {
          sessionId: session.id,
          message: `任务认领未启动: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      try {
        try {
          await activeRun;
        } finally {
          services.finishClaimIfOpen(task.id);
        }
      } catch (error) {
        event('notice', {
          sessionId: session.id,
          message: `任务 ${task.id} 的运行结果需要检查: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
  } catch (error) {
    event('notice', {
      message: `调度检查失败: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
const scheduler = setInterval(() => {
  if (active || scheduled || shuttingDown) return;
  scheduled = scheduleTick().finally(() => {
    scheduled = undefined;
  });
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
  memoryReviewRun?.controller.abort();
  for (const pending of approvals.values()) pending.resolve(false);
  approvals.clear();
  await activeRun;
  await scheduled;
  await memoryReviewRun?.result.catch(() => {});
  await services.close();
  await executor.close();
  store.close();
}
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
