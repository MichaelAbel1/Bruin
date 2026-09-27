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
  readSkill,
  setSkillEnabled,
  marketEntries,
  uninstallSkill,
  updateSkill,
} from './skills/registry.js';
import { searchSkillsSh, installSkillsSh } from './skills/skills-sh.js';
import type { ModelProfile, ProviderKind, ToolCall } from './core/types.js';

const help = `Bruin — local coding agent

bruin model add ALIAS PROVIDER MODEL [BASE_URL] [API_KEY_ENV]
bruin model list | default ALIAS
bruin chat [--model ALIAS] [--workspace DIR] [--resume SESSION_ID] [PROMPT]
bruin sessions list | show SESSION_ID
bruin skill list | show NAME | enable NAME | disable NAME | install-local DIR | install-github OWNER/REPO SUBDIR [REF] | update NAME | remove NAME
bruin market add NAME OWNER/REPO | list | search NAME | install MARKET SKILL
bruin market skills-sh-search QUERY | skills-sh-install OWNER/REPO/SKILL

PROVIDER: openai, anthropic, google, openai-compatible.
API keys are read from environment variables and never stored in the session database.`;
function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return;
  const value = args[i + 1];
  if (!value) throw new Error(`${name} 缺少值`);
  args.splice(i, 2);
  return value;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const area = args.shift();
  if (!area || area === 'help' || area === '--help') {
    console.log(help);
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
      const profile: ModelProfile = {
        alias,
        provider: provider as ProviderKind,
        model,
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
      };
      cfg.profiles = cfg.profiles.filter((x) => x.alias !== alias);
      cfg.profiles.push(profile);
      cfg.defaultProfile ??= alias;
      saveConfig(cfg);
      console.log(`已保存 ${alias}`);
      return;
    }
    if (action === 'default') {
      const alias = args[0];
      if (!cfg.profiles.some((x) => x.alias === alias)) throw new Error('模型配置不存在');
      cfg.defaultProfile = alias;
      saveConfig(cfg);
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
      console.log(readSkill(args[0]));
      return;
    }
    if (action === 'enable' || action === 'disable') {
      setSkillEnabled(args[0], action === 'enable');
      console.log(`Skill ${action === 'enable' ? '已启用' : '已禁用'}`);
      return;
    }
    if (action === 'install-local') {
      console.log(JSON.stringify(installLocal(args[0]), null, 2));
      return;
    }
    if (action === 'install-github') {
      console.log(JSON.stringify(installGithub(args[0], args[1], args[2]), null, 2));
      return;
    }
    if (action === 'update') {
      console.log(JSON.stringify(await updateSkill(args[0]), null, 2));
      return;
    }
    if (action === 'remove') {
      uninstallSkill(args[0]);
      console.log('已卸载');
      return;
    }
    throw new Error(help);
  }
  if (area === 'market') {
    const action = args.shift();
    if (action === 'add') {
      addMarket(args[0], args[1]);
      console.log('市场已添加');
      return;
    }
    if (action === 'list') {
      console.log(JSON.stringify(loadConfig().marketplaces, null, 2));
      return;
    }
    if (action === 'search') {
      console.log(JSON.stringify(marketEntries(args[0]), null, 2));
      return;
    }
    if (action === 'install') {
      console.log(JSON.stringify(installFromMarket(args[0], args[1]), null, 2));
      return;
    }
    if (action === 'skills-sh-search') {
      console.log(JSON.stringify(await searchSkillsSh(args.join(' ')), null, 2));
      return;
    }
    if (action === 'skills-sh-install') {
      console.log(JSON.stringify(await installSkillsSh(args[0]), null, 2));
      return;
    }
    throw new Error(help);
  }
  const store = new SqliteEventStore(path.join(dataDir(), 'sessions.sqlite'));
  try {
    if (area === 'sessions') {
      const action = args.shift();
      if (action === 'list') {
        console.log(JSON.stringify(store.listSessions(), null, 2));
        return;
      }
      if (action === 'show') {
        console.log(JSON.stringify(store.events(args[0]), null, 2));
        return;
      }
      throw new Error(help);
    }
    if (area !== 'chat') throw new Error(help);
    const modelAlias = takeFlag(args, '--model');
    const workspaceArg = takeFlag(args, '--workspace');
    const resume = takeFlag(args, '--resume');
    const workspace = fs.realpathSync(workspaceArg ?? process.cwd());
    let session = resume
      ? store.getSession(resume)
      : store.createSession(workspace, findProfile(modelAlias));
    if (!session) throw new Error('会话不存在');
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
    const io = {
      text: (delta: string) => stdout.write(delta),
      notice: (message: string) => console.log(`\n[工具] ${message}`),
      approve: async (call: ToolCall, reason: string) => {
        const answer = await rl.question(
          `\n批准 ${call.name} ${JSON.stringify(call.input)}? ${reason} [y/N] `,
        );
        return /^y(es)?$/i.test(answer.trim());
      },
    };
    const runner = new AgentRunner(store, new AiSdkGateway(), executor, io);
    const controller = new AbortController();
    const leaseOwner = randomUUID();
    const leaseSessionId = session.id;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let leaseAcquired = false;
    process.once('SIGINT', () => controller.abort());
    try {
      store.acquireLease(leaseSessionId, leaseOwner, 30_000);
      leaseAcquired = true;
      heartbeat = setInterval(() => {
        if (!store.renewLease(leaseSessionId, leaseOwner, 30_000)) controller.abort();
      }, 10_000);
      const unknown = resume ? runner.recover(session) : 0;
      if (unknown) {
        const answer = await rl.question(
          `发现 ${unknown} 个结果未知的工具调用。请检查工作区后继续。[y/N] `,
        );
        if (!/^y(es)?$/i.test(answer.trim())) return;
      }
      console.log(
        `会话 ${session.id} | 工作区 ${session.workspace} | 模型 ${session.profile.alias}`,
      );
      let prompt = args.join(' ');
      if (prompt) {
        await runner.run(session, prompt, controller.signal);
        stdout.write('\n');
      } else if (
        resume &&
        store.events(session.id).length &&
        store.events(session.id).at(-1)?.type !== 'turn_completed'
      ) {
        await runner.run(session, undefined, controller.signal);
        stdout.write('\n');
      }
      while (!controller.signal.aborted && stdin.isTTY) {
        const line = await rl.question('\n你> ');
        if (line.trim() === '/exit') break;
        if (line.startsWith('/model ')) {
          store.setProfile(session.id, findProfile(line.slice(7).trim()), leaseOwner);
          session = store.getSession(session.id)!;
          console.log(`模型已切换为 ${session.profile.alias}`);
          continue;
        }
        if (!line.trim()) continue;
        await runner.run(session, line, controller.signal);
        stdout.write('\n');
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (leaseAcquired) store.releaseLease(leaseSessionId, leaseOwner);
      await executor.close();
      rl.close();
    }
  } finally {
    store.close();
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
