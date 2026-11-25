#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  dataDir,
  findProfile,
  getRuntimeApiKey,
  loadConfig,
  looksLikeApiKey,
  saveConfig,
  updateConfig,
  setRuntimeApiKey,
  validApiKeyEnv,
  isAllowedWebhookUrl,
} from './config.js';
import { SqliteEventStore } from './storage/event-store.js';
import { AiSdkGateway, resolveApiKey } from './providers/gateway.js';
import { ProcessExecutor } from './executor/client.js';
import { AgentRunner } from './core/agent.js';
import { isAutoSafeShell, isMaliciousShell } from './core/approval-policy.js';
import {
  addMarket,
  installFromMarket,
  installGithub,
  installLocal,
  listSkills,
  readSkill,
  setSkillEnabled,
  marketEntries,
  uninstallSkill,
  updateSkill,
} from './skills/registry.js';
import { searchSkillsSh, installSkillsSh } from './skills/skills-sh.js';
import type { ModelProfile, ProviderKind, ToolCall } from './core/types.js';
import { RuntimeServices } from './runtime/services.js';
import { createSubagentRunner } from './runtime/subagent.js';
import { canResumeTurn, turnState } from './core/turn-state.js';
import { reduceSessionState, type SessionState } from './core/session-state.js';
import { pendingQuestion, recordQuestionAnswer, type PendingQuestion } from './core/question.js';
import { runService } from './runtime/service.js';
import { sendAttentionWebhook } from './runtime/notify.js';
import { toolsForMode, toolDefinitions } from './core/tools.js';
import { recoverSession } from './core/recovery.js';
import { recordUnknownReview, unreviewedUnknownTools } from './core/unknown-review.js';

const help = `Bruin — local coding agent

bruin model add ALIAS PROVIDER MODEL [BASE_URL] [API_KEY_ENV] [--context-tokens N]
bruin model list | default ALIAS
bruin chat [--model ALIAS] [--workspace DIR] [--resume SESSION_ID] [--answer QUESTION_ID] [--max-model-calls 24|96|240|480] [--allow-workspace-edits] [--unattended] [--json] [PROMPT]
bruin sessions list | show SESSION_ID | status SESSION_ID
bruin service run [--timezone IANA_ZONE]
bruin acp [--model ALIAS]
bruin cron list | review JOB_ID --confirm
bruin webhook show | set URL | clear
bruin backup create DIRECTORY | inspect DIRECTORY | restore DIRECTORY --confirm TOKEN
bruin doctor
bruin capabilities
bruin skill list | show NAME | enable NAME | disable NAME | install-local DIR | install-github OWNER/REPO SUBDIR [REF] | update NAME | remove NAME
bruin market add NAME OWNER/REPO | list | search NAME | install MARKET SKILL
bruin market skills-sh-search QUERY | skills-sh-install OWNER/REPO/SKILL

PROVIDER: openai, anthropic, google, openai-compatible.
For non-interactive chat, pass a prompt as arguments or on stdin (UTF-8, up to 1 MB).
API keys are read from environment variables and never stored in the session database.`;
function requireArg(value: string | undefined, message = help): string {
  if (!value) throw new Error(message);
  return value;
}
async function askLine(
  rl: ReturnType<typeof createInterface>,
  promptText: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted) throw new Error('已取消');
  let onClose!: () => void;
  const closed = new Promise<null>((resolve) => {
    onClose = () => resolve(null);
    rl.once('close', onClose);
  });
  const pending = rl.question(promptText, { signal });
  void pending.catch(() => {});
  try {
    return await Promise.race([pending, closed]);
  } finally {
    rl.removeListener('close', onClose);
  }
}
function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return;
  const value = args[i + 1];
  if (!value) throw new Error(`${name} 缺少值`);
  args.splice(i, 2);
  return value;
}
async function readChatPrompt(positional: string): Promise<string> {
  const argument = positional.trim() ? positional : '';
  if (stdin.isTTY) return argument;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_000_000) throw new Error('stdin 提示词超过 1 MB');
    chunks.push(bytes);
  }
  let piped: string;
  try {
    piped = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch {
    throw new Error('stdin 提示词必须是有效的 UTF-8 文本');
  }
  if (!piped.trim()) return argument;
  if (argument) throw new Error('请只通过 stdin 或位置参数提供提示词');
  return piped;
}
async function chatOptions(args: string[]) {
  const modelAlias = takeFlag(args, '--model');
  const workspaceArg = takeFlag(args, '--workspace');
  const resume = takeFlag(args, '--resume');
  const answerTo = takeFlag(args, '--answer');
  const maxCallsArg = takeFlag(args, '--max-model-calls');
  const maxModelCalls = maxCallsArg === undefined ? 24 : Number(maxCallsArg);
  const allowWorkspaceEdits = args.includes('--allow-workspace-edits');
  if (allowWorkspaceEdits) args.splice(args.indexOf('--allow-workspace-edits'), 1);
  const unattended = args.includes('--unattended');
  if (unattended) args.splice(args.indexOf('--unattended'), 1);
  const jsonOutput = args.includes('--json');
  if (jsonOutput) args.splice(args.indexOf('--json'), 1);
  if (![24, 96, 240, 480].includes(maxModelCalls)) throw new Error('无效的长任务调用预算');
  if (allowWorkspaceEdits && maxModelCalls === 24)
    throw new Error('--allow-workspace-edits 需要长任务调用预算');
  if (unattended && maxModelCalls === 24) throw new Error('--unattended 需要长任务调用预算');
  if (maxModelCalls === 480 && !unattended) throw new Error('480 次模型调用需要 --unattended');
  const effectiveUnattended = unattended || jsonOutput || !stdin.isTTY;
  const prompt = await readChatPrompt(args.join(' '));
  if (answerTo !== undefined && (!resume || !prompt.trim()))
    throw new Error('--answer 需要 --resume 和答复内容');
  if (effectiveUnattended && !resume && !prompt)
    throw new Error('非交互式 chat 需要提示词或 --resume');
  return {
    modelAlias,
    workspaceArg,
    resume,
    answerTo,
    maxModelCalls,
    allowWorkspaceEdits,
    effectiveUnattended,
    jsonOutput,
    prompt,
  };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const area = args.shift();
  if (!area || area === 'help' || area === '--help') {
    console.log(help);
    return;
  }
  if (area === 'service') {
    const action = args.shift();
    const timezone = takeFlag(args, '--timezone');
    if (action !== 'run' || args.length) throw new Error(help);
    await runService(timezone);
    return;
  }
  if (area === 'acp') {
    const model = takeFlag(args, '--model');
    if (args.length) throw new Error(help);
    const { runAcp } = await import('./runtime/acp.js');
    await runAcp(model);
    return;
  }
  if (area === 'doctor') {
    if (args.length) throw new Error(help);
    const { doctor } = await import('./runtime/doctor.js');
    const result = doctor();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (area === 'webhook') {
    const action = args.shift();
    if (action === 'show' && !args.length) {
      const cfg = loadConfig();
      const envUrl = process.env.BRUIN_WEBHOOK_URL?.trim();
      console.log(
        JSON.stringify(
          {
            configWebhookUrl: cfg.webhookUrl ?? null,
            envConfigured: Boolean(envUrl),
            envValid: envUrl ? isAllowedWebhookUrl(envUrl) : null,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (action === 'set' && args.length === 1) {
      const url = args[0].trim();
      if (!isAllowedWebhookUrl(url))
        throw new Error('Webhook 地址必须使用 HTTPS（或本机 localhost HTTP）且不能包含内嵌凭据');
      updateConfig((current) => ({ ...current, webhookUrl: url }));
      console.log(`已保存 Webhook: ${url}`);
      return;
    }
    if (action === 'clear' && !args.length) {
      updateConfig((current) => {
        const next = { ...current };
        delete next.webhookUrl;
        return next;
      });
      console.log('已清除 Webhook 配置');
      return;
    }
    throw new Error('用法: bruin webhook show | set URL | clear');
  }
  if (area === 'capabilities') {
    if (args.length) throw new Error(help);
    console.log(
      JSON.stringify(
        {
          modes: {
            cli: Object.keys(toolsForMode('full', true)),
            desktop: Object.keys(toolsForMode('full', true)),
            acp: Object.keys(toolsForMode('full')),
            service: Object.keys(toolsForMode('full', true)),
            subagent: Object.keys(toolsForMode('read-only')),
            worktreeSubagent: Object.keys(toolsForMode('worktree')),
          },
          tools: Object.fromEntries(
            Object.entries(toolDefinitions).map(([name, definition]) => [
              name,
              {
                readOnly: definition.readOnly,
                planning: definition.planning,
                target: definition.target,
                replay: definition.replay,
              },
            ]),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (area === 'backup') {
    const action = args.shift();
    const confirmation = takeFlag(args, '--confirm');
    if (
      args.length !== 1 ||
      !['create', 'inspect', 'restore'].includes(action ?? '') ||
      (action !== 'restore' && confirmation !== undefined)
    )
      throw new Error(help);
    const backup = await import('./storage/backup.js');
    const result =
      action === 'create'
        ? await backup.createBackup(dataDir(), args[0])
        : action === 'inspect'
          ? await backup.previewBackup(args[0])
          : await backup.restoreBackup(dataDir(), args[0], confirmation ?? '');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (area === 'model') {
    const action = args.shift();
    const cfg = loadConfig();
    if (action === 'list') {
      console.log(JSON.stringify({ default: cfg.defaultProfile, profiles: cfg.profiles }, null, 2));
      return;
    }
    if (action === 'add') {
      const contextTokensArg = takeFlag(args, '--context-tokens');
      const [alias, provider, model, baseUrl, apiKeyEnv] = args;
      if (
        !alias ||
        !model ||
        !['openai', 'anthropic', 'google', 'openai-compatible'].includes(provider)
      )
        throw new Error('用法: bruin model add ALIAS PROVIDER MODEL [BASE_URL] [API_KEY_ENV]');
      if (provider === 'openai-compatible' && !baseUrl)
        throw new Error('openai-compatible 需要 BASE_URL');
      if (apiKeyEnv && !validApiKeyEnv(apiKeyEnv))
        throw new Error('API_KEY_ENV 只能填写环境变量名称，不能填写密钥值');
      const contextWindowTokens =
        contextTokensArg === undefined ? undefined : Number(contextTokensArg);
      if (
        contextWindowTokens !== undefined &&
        (!Number.isInteger(contextWindowTokens) ||
          contextWindowTokens < 8192 ||
          contextWindowTokens > 1_048_576)
      )
        throw new Error('--context-tokens 须为 8192 到 1048576 之间的整数');
      const profile: ModelProfile = {
        alias,
        provider: provider as ProviderKind,
        model,
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
        ...(contextWindowTokens ? { contextWindowTokens } : {}),
      };
      updateConfig((current) => {
        current.profiles = current.profiles.filter((x) => x.alias !== alias);
        current.profiles.push(profile);
        current.defaultProfile ??= alias;
        return current;
      });
      console.log(`已保存 ${alias}`);
      return;
    }
    if (action === 'default') {
      const alias = args[0];
      updateConfig((current) => {
        if (!current.profiles.some((x) => x.alias === alias)) throw new Error('模型配置不存在');
        current.defaultProfile = alias;
        return current;
      });
      console.log(`默认模型: ${alias}`);
      return;
    }
    throw new Error(help);
  }
  if (area === 'skill') {
    const action = args.shift();
    if (action === 'list') {
      console.log(JSON.stringify(listSkills(), null, 2));
      return;
    }
    if (action === 'show') {
      console.log(readSkill(requireArg(args[0])));
      return;
    }
    if (action === 'enable' || action === 'disable') {
      setSkillEnabled(requireArg(args[0]), action === 'enable');
      console.log(`Skill ${action === 'enable' ? '已启用' : '已禁用'}`);
      return;
    }
    if (action === 'install-local') {
      console.log(JSON.stringify(installLocal(requireArg(args[0])), null, 2));
      return;
    }
    if (action === 'install-github') {
      console.log(
        JSON.stringify(installGithub(requireArg(args[0]), requireArg(args[1]), args[2]), null, 2),
      );
      return;
    }
    if (action === 'update') {
      console.log(JSON.stringify(await updateSkill(requireArg(args[0])), null, 2));
      return;
    }
    if (action === 'remove') {
      uninstallSkill(requireArg(args[0]));
      console.log('已卸载');
      return;
    }
    throw new Error(help);
  }
  if (area === 'market') {
    const action = args.shift();
    if (action === 'add') {
      addMarket(requireArg(args[0]), requireArg(args[1]));
      console.log('市场已添加');
      return;
    }
    if (action === 'list') {
      console.log(JSON.stringify(loadConfig().marketplaces, null, 2));
      return;
    }
    if (action === 'search') {
      console.log(JSON.stringify(marketEntries(requireArg(args[0])), null, 2));
      return;
    }
    if (action === 'install') {
      console.log(
        JSON.stringify(installFromMarket(requireArg(args[0]), requireArg(args[1])), null, 2),
      );
      return;
    }
    if (action === 'skills-sh-search') {
      console.log(JSON.stringify(await searchSkillsSh(args.join(' ')), null, 2));
      return;
    }
    if (action === 'skills-sh-install') {
      console.log(JSON.stringify(await installSkillsSh(requireArg(args[0])), null, 2));
      return;
    }
    throw new Error(help);
  }
  const chat = area === 'chat' ? await chatOptions(args) : undefined;
  const store = new SqliteEventStore(path.join(dataDir(), 'sessions.sqlite'));
  try {
    if (area === 'cron') {
      const action = args.shift();
      const jobs = store.listSessions().flatMap((session) => store.listCronJobs(session.id));
      if (action === 'list' && !args.length) {
        console.log(JSON.stringify(jobs, null, 2));
        return;
      }
      const job = jobs.find((job) => job.id === args[0]);
      if (action !== 'review' || !job || args[1] !== '--confirm' || args.length !== 2)
        throw new Error(
          '检查会话事件及工作区后，使用 bruin cron review JOB_ID --confirm 解锁后续调度',
        );
      const owner = randomUUID();
      store.acquireLease(job.sessionId, owner, 10_000);
      try {
        const revealed = recoverSession(store, job.sessionId);
        if (revealed > 0)
          throw new Error(
            `新发现 ${revealed} 个结果未知的工具调用。请运行 bruin sessions show ${job.sessionId} 并检查工作区，再确认。`,
          );
        const throughSeq =
          store
            .events(job.sessionId)
            .filter((event) => event.type === 'tool_unknown')
            .at(-1)?.seq ?? 0;
        store.append(job.sessionId, 'cron_reviewed', { jobId: job.id, throughSeq });
        store.markCronJob(job.id, 'reviewed');
      } finally {
        store.releaseLease(job.sessionId, owner);
      }
      console.log('已确认检查，后续到期调度已解锁');
      return;
    }
    if (area === 'sessions') {
      const action = args.shift();
      if (action === 'list') {
        console.log(JSON.stringify(store.listSessions(), null, 2));
        return;
      }
      if (action === 'show') {
        const sessionId = requireArg(args[0]);
        if (!store.getSession(sessionId)) throw new Error('会话不存在');
        console.log(JSON.stringify(store.events(sessionId), null, 2));
        return;
      }
      if (action === 'status') {
        const sessionId = requireArg(args[0]);
        const session = store.getSession(sessionId);
        if (!session) throw new Error('会话不存在');
        console.log(
          JSON.stringify(
            {
              session,
              leased: store.isLeased(sessionId),
              state: reduceSessionState(store.events(sessionId)),
            },
            null,
            2,
          ),
        );
        return;
      }
      throw new Error(help);
    }
    if (!chat) throw new Error(help);
    const {
      modelAlias,
      workspaceArg,
      resume,
      answerTo,
      maxModelCalls,
      allowWorkspaceEdits,
      effectiveUnattended,
      jsonOutput,
      prompt,
    } = chat;
    const workspace = fs.realpathSync(workspaceArg ?? process.cwd());
    const loadedSession = resume
      ? store.getSession(resume)
      : store.createSession(workspace, findProfile(modelAlias));
    if (!loadedSession) throw new Error('会话不存在');
    let session = loadedSession;
    if (resume && session.profile.apiKeyEnv && !validApiKeyEnv(session.profile.apiKeyEnv)) {
      const config = loadConfig();
      if (!getRuntimeApiKey(session.profile.alias) && looksLikeApiKey(session.profile.apiKeyEnv))
        setRuntimeApiKey(session.profile.alias, session.profile.apiKeyEnv);
      const clean = config.profiles.find((x) => x.alias === session!.profile.alias) ?? {
        ...session.profile,
        apiKeyEnv: undefined,
      };
      store.setProfile(session.id, clean);
      session = store.getSession(session.id)!;
    }
    if (resume && workspaceArg && workspace !== session.workspace)
      throw new Error('恢复会话时工作区不匹配');
    const rl = createInterface({ input: stdin, output: stdout });
    const executor = new ProcessExecutor();
    let assistantOutput = '';
    const io = {
      text: (delta: string) => {
        if (jsonOutput) assistantOutput += delta;
        else stdout.write(delta);
      },
      notice: (message: string) => {
        if (!jsonOutput) console.log(`\n[工具] ${message}`);
      },
      approve: async (call: ToolCall, reason: string, signal: AbortSignal) => {
        if (allowWorkspaceEdits && ['write_file', 'edit_file'].includes(call.name)) return true;
        const config = loadConfig();
        const command =
          (call.name === 'shell' || call.name === 'start_background') &&
          typeof call.input.command === 'string'
            ? call.input.command
            : '';
        if (config.approvalMode === 'auto') {
          if (call.name === 'shell' || call.name === 'start_background') {
            if (!isMaliciousShell(command)) return true;
          } else {
            return true;
          }
        }
        if (command && !isMaliciousShell(command)) {
          if (
            config.approvedCommands.some(
              (rule) =>
                rule.workspace === session!.workspace &&
                rule.command === command &&
                (!rule.sessionId || rule.sessionId === session!.id),
            ) ||
            (config.approvalMode === 'autoSafe' && isAutoSafeShell(command))
          )
            return true;
        }
        if (effectiveUnattended)
          return '无人值守模式：此操作没有预先授权，已拒绝。请不要重复请求；改用已授权工具或说明需要用户批准。';
        const answer = await askLine(
          rl,
          `\n批准 ${call.name} ${JSON.stringify(call.input)}? ${reason} [y/N] `,
          signal,
        );
        return answer !== null && /^y(es)?$/i.test(answer.trim());
      },
    };
    const services = new RuntimeServices(store, executor, createSubagentRunner(store, executor));
    const runner = new AgentRunner(store, new AiSdkGateway('full', true), executor, io, services);
    const runOptions =
      maxModelCalls > 24
        ? {
            maxModelCalls,
            maxDurationMs: 8 * 60 * 60 * 1000,
            checkpointEvery: 24,
            allowQuestions: true,
            unattended: effectiveUnattended,
            allowWorkspaceEdits,
          }
        : { unattended: effectiveUnattended, allowWorkspaceEdits, allowQuestions: true };
    const controller = new AbortController();
    const leaseSessionId = session.id;
    let lease: ReturnType<RuntimeServices['sessionLeases']['retain']> | undefined;
    const onStopSignal = () => controller.abort();
    process.once('SIGINT', onStopSignal);
    process.once('SIGTERM', onStopSignal);
    const cliSecrets = (): string[] => {
      const secrets: string[] = [];
      const runtime = getRuntimeApiKey(session.profile.alias);
      if (runtime) secrets.push(runtime);
      try {
        const resolved = resolveApiKey(session.profile);
        if (resolved) secrets.push(resolved);
      } catch {}
      return secrets;
    };
    const notifyAttention = async (state: SessionState, failureMessage?: string) => {
      const extraSecrets = cliSecrets();
      if (failureMessage) {
        await sendAttentionWebhook(
          {
            event: 'run_failed',
            sessionId: leaseSessionId,
            workspace: session.workspace,
            phase: state.phase,
            reason: failureMessage.slice(0, 500),
          },
          { extraSecrets },
        );
        return;
      }
      if (state.phase === 'awaiting_input' && state.pendingQuestion) {
        await sendAttentionWebhook(
          {
            event: 'awaiting_input',
            sessionId: leaseSessionId,
            workspace: session.workspace,
            phase: state.phase,
            questionId: state.pendingQuestion.id,
            question: state.pendingQuestion.text,
            options: state.pendingQuestion.options,
          },
          { extraSecrets },
        );
      } else if (state.phase === 'paused') {
        await sendAttentionWebhook(
          {
            event: 'paused',
            sessionId: leaseSessionId,
            workspace: session.workspace,
            phase: state.phase,
          },
          { extraSecrets },
        );
      } else if (state.phase === 'awaiting_review') {
        await sendAttentionWebhook(
          {
            event: 'awaiting_review',
            sessionId: leaseSessionId,
            workspace: session.workspace,
            phase: state.phase,
            reason: `发现 ${state.unreviewedUnknownCount} 个结果未知的工具调用需要人工检查`,
          },
          { extraSecrets },
        );
      }
    };
    try {
      lease = services.sessionLeases.retain(leaseSessionId, controller);
      if (resume) runner.recover(session);
      const printQuestion = (question: PendingQuestion) => {
        const kindLabel = question.kind ? ` [${question.kind}]` : '';
        console.log(`\n待答问题 ${question.id}${kindLabel}\n${question.text}`);
        if (question.context) console.log(`背景：${question.context}`);
        if (question.options?.length) {
          console.log('候选项：');
          for (const [index, option] of question.options.entries())
            console.log(`  ${index + 1}. ${option}`);
        }
      };
      const emitJsonSummary = (exitCode: number) => {
        const events = store.events(leaseSessionId);
        const state = reduceSessionState(events);
        const lastAssistant = [...events]
          .reverse()
          .find((event) => event.type === 'assistant' && typeof event.payload.text === 'string');
        const answer =
          assistantOutput ||
          (typeof lastAssistant?.payload.text === 'string' ? lastAssistant.payload.text : '');
        console.log(
          JSON.stringify(
            {
              ok: true,
              sessionId: leaseSessionId,
              workspace: session.workspace,
              model: session.profile.alias,
              exitCode,
              phase: state.phase,
              turnState: state.turnState,
              canResume: state.canResume,
              needsReview: state.needsReview,
              pendingQuestion: state.pendingQuestion,
              usage: state.usage,
              answer,
            },
            null,
            2,
          ),
        );
        process.exitCode = exitCode;
      };
      while (true) {
        const unknown = unreviewedUnknownTools(store.events(session.id));
        const lastUnknown = unknown.at(-1);
        if (!lastUnknown) break;
        if (effectiveUnattended) {
          const state = reduceSessionState(store.events(session.id));
          await notifyAttention(state);
          if (jsonOutput) emitJsonSummary(3);
          else {
            console.error(
              `发现 ${unknown.length} 个结果未知的工具调用；请检查工作区后交互式继续。`,
            );
            process.exitCode = 3;
          }
          return;
        }
        const answer = await askLine(
          rl,
          `发现 ${unknown.length} 个结果未知的工具调用。请检查工作区后继续。[y/N] `,
          controller.signal,
        );
        if (answer === null || !/^y(es)?$/i.test(answer.trim())) return;
        const reviewLease = services.sessionLeases.retain(session.id, controller);
        try {
          recordUnknownReview(store, session.id, lastUnknown.seq, 'cli');
        } finally {
          reviewLease.release();
        }
      }
      if (!jsonOutput) {
        console.log(
          `会话 ${session.id} | 工作区 ${session.workspace} | 模型 ${session.profile.alias}`,
        );
      }
      const reportQuestionUnattended = async () => {
        const state = reduceSessionState(store.events(leaseSessionId));
        const question = state.pendingQuestion;
        if (!question) return false;
        await notifyAttention(state);
        if (jsonOutput) {
          emitJsonSummary(2);
        } else {
          printQuestion(question);
          console.log(
            `使用 bruin chat --resume ${leaseSessionId} --answer ${question.id} "答复" 继续任务`,
          );
          process.exitCode = 2;
        }
        return true;
      };
      const resolvePendingQuestionsInteractively = async (): Promise<boolean> => {
        while (!controller.signal.aborted) {
          const question = pendingQuestion(store.events(leaseSessionId));
          if (!question) return true;
          printQuestion(question);
          const promptLabel = question.options?.length
            ? '\n答复 (输入选项编号或自由文本，/exit 稍后继续)> '
            : '\n答复 (/exit 稍后继续)> ';
          const line = await askLine(rl, promptLabel, controller.signal);
          if (controller.signal.aborted) throw new Error('已取消');
          if (line === null || !line.trim() || line.trim() === '/exit') {
            console.log(
              `使用 bruin chat --resume ${leaseSessionId} --answer ${question.id} "答复" 继续任务`,
            );
            process.exitCode = 2;
            return false;
          }
          const trimmed = line.trim();
          const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
          const reply =
            question.options &&
            Number.isInteger(numeric) &&
            numeric >= 1 &&
            numeric <= question.options.length
              ? question.options[numeric - 1]!
              : trimmed;
          recordQuestionAnswer(store, leaseSessionId, question.id, reply);
          store.append(session.id, 'run_configured', {
            maxModelCalls,
            allowWorkspaceEdits,
            unattended: effectiveUnattended,
          });
          await runner.run(session, undefined, controller.signal, [], undefined, runOptions);
          stdout.write('\n');
        }
        return false;
      };
      if (answerTo !== undefined) recordQuestionAnswer(store, session.id, answerTo, prompt);
      else if (effectiveUnattended) {
        if (await reportQuestionUnattended()) return;
      } else if (!(await resolvePendingQuestionsInteractively())) {
        return;
      }
      if (prompt) {
        store.append(session.id, 'run_configured', {
          maxModelCalls,
          allowWorkspaceEdits,
          unattended: effectiveUnattended,
        });
        await runner.run(
          session,
          answerTo === undefined ? prompt : undefined,
          controller.signal,
          [],
          undefined,
          runOptions,
        );
        if (!jsonOutput) stdout.write('\n');
      } else if (resume && canResumeTurn(store.events(session.id))) {
        store.append(session.id, 'run_configured', {
          maxModelCalls,
          allowWorkspaceEdits,
          unattended: effectiveUnattended,
        });
        await runner.run(session, undefined, controller.signal, [], undefined, runOptions);
        if (!jsonOutput) stdout.write('\n');
      }
      if (effectiveUnattended) {
        if (await reportQuestionUnattended()) return;
        const state = reduceSessionState(store.events(session.id));
        if (state.phase === 'awaiting_review') {
          await notifyAttention(state);
          if (jsonOutput) emitJsonSummary(3);
          else process.exitCode = 3;
          return;
        }
        if (state.phase === 'paused' || state.phase === 'awaiting_plan_approval') {
          await notifyAttention(state);
          if (jsonOutput) emitJsonSummary(2);
          else process.exitCode = 2;
          return;
        }
        if (jsonOutput) emitJsonSummary(0);
        return;
      }
      while (!controller.signal.aborted) {
        if (!(await resolvePendingQuestionsInteractively())) break;
        const line = await askLine(rl, '\n你> ', controller.signal);
        if (controller.signal.aborted) throw new Error('已取消');
        if (line === null || line.trim() === '/exit') break;
        if (line.trim() === '/continue' || !line.trim()) {
          if (canResumeTurn(store.events(session.id))) {
            store.append(session.id, 'run_configured', {
              maxModelCalls,
              allowWorkspaceEdits,
              unattended: effectiveUnattended,
            });
            await runner.run(session, undefined, controller.signal, [], undefined, runOptions);
          } else if (line.trim()) console.log('当前没有暂停的任务');
          continue;
        }
        if (line.trim() === '/stop') {
          if (turnState(store.events(session.id)) === 'paused') {
            store.append(session.id, 'turn_completed', { stoppedByUser: true });
            console.log('已结束暂停的任务');
          } else console.log('当前没有暂停的任务');
          continue;
        }
        if (line.startsWith('/model ')) {
          store.setProfile(session.id, findProfile(line.slice(7).trim()), lease.owner);
          session = store.getSession(session.id)!;
          console.log(`模型已切换为 ${session.profile.alias}`);
          continue;
        }
        store.append(session.id, 'run_configured', {
          maxModelCalls,
          allowWorkspaceEdits,
          unattended: effectiveUnattended,
        });
        await runner.run(session, line, controller.signal, [], undefined, runOptions);
        stdout.write('\n');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = reduceSessionState(store.events(leaseSessionId));
      if (effectiveUnattended) await notifyAttention(state, message);
      if (jsonOutput) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              sessionId: leaseSessionId,
              workspace: session.workspace,
              model: session.profile.alias,
              exitCode: 1,
              phase: state.phase,
              error: message,
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    } finally {
      process.removeListener('SIGINT', onStopSignal);
      process.removeListener('SIGTERM', onStopSignal);
      try {
        lease?.release();
      } finally {
        try {
          await services.close();
        } finally {
          try {
            await executor.close();
          } finally {
            rl.close();
          }
        }
      }
    }
  } finally {
    store.close();
  }
}
main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (process.argv[2] === 'chat' && process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: false, exitCode: 1, error: message }, null, 2));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});
