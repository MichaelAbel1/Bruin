import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EventStore } from '../storage/event-store.js';
import type { TaskNode } from '../storage/event-store.js';
import type { ToolExecutor } from '../executor/client.js';
import type { Session, ToolCall, ToolResult } from '../core/types.js';
import { dataDir, loadConfig, type HookConfig } from '../config.js';
import { McpManager } from './mcp.js';
import { planState, setPlanProgress } from './plan.js';
import { SessionLeases } from '../core/session-leases.js';

const execFileAsync = promisify(execFile);
type Background = {
  sessionId: string;
  controller: AbortController;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: ToolResult;
};
type Subagent = {
  sessionId: string;
  controller: AbortController;
  status: 'running' | 'completed' | 'failed';
  error?: string;
};

export class RuntimeServices {
  readonly mcp = new McpManager();
  readonly sessionLeases: SessionLeases;
  private readonly taskOwner = randomUUID();
  private readonly claimedTasks = new Set<string>();
  private readonly taskHeartbeat: ReturnType<typeof setInterval>;
  private background = new Map<string, Background>();
  private subagents = new Map<string, Subagent>();
  private pending = new Set<Promise<unknown>>();
  constructor(
    private store: EventStore,
    private executor: ToolExecutor,
    private runSubagent: (session: Session, prompt: string, signal: AbortSignal) => Promise<void>,
  ) {
    this.sessionLeases = new SessionLeases(store);
    this.taskHeartbeat = setInterval(() => {
      for (const id of this.claimedTasks) {
        try {
          if (!this.store.renewTask(id, this.taskOwner, 3_600_000)) this.claimedTasks.delete(id);
        } catch {
          // Keep the claim for a retry; the store still rejects expired ownership.
          process.stderr.write('Bruin task lease renewal failed; retrying on next heartbeat\n');
        }
      }
    }, 60_000);
    this.taskHeartbeat.unref();
  }
  claimReadyTask(session: Session): TaskNode | undefined {
    const task = this.store.claimTask(session.id, this.taskOwner, 3_600_000);
    if (task) this.claimedTasks.add(task.id);
    return task;
  }
  releaseClaim(id: string): void {
    this.store.releaseTask(id, this.taskOwner);
    this.claimedTasks.delete(id);
  }
  finishClaimIfOpen(id: string): void {
    if (!this.claimedTasks.has(id)) return;
    try {
      this.store.finishTask(id, this.taskOwner, false);
    } finally {
      this.claimedTasks.delete(id);
    }
  }

  async runHooks(event: HookConfig['event'], session: Session, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('已取消');
    if (session.managedWorkspace && !fs.existsSync(session.workspace)) return;
    if (!fs.existsSync(session.workspace)) throw new Error('工作区目录不存在');
    for (const hook of loadConfig().hooks.filter((item) => item.enabled && item.event === event)) {
      if (signal.aborted) throw new Error('已取消');
      const result = await this.executor.execute(
        {
          requestId: randomUUID(),
          name: 'shell',
          input: { command: hook.command },
          workspace: session.workspace,
          timeoutMs: 30_000,
          maxOutputBytes: 10_000,
          requireSandbox: true,
        },
        signal,
      );
      this.store.append(session.id, 'hook_finished', {
        name: hook.name,
        event,
        isError: result.isError,
        output: result.output,
      });
      if (result.isError && (event === 'before_tool' || event === 'turn_started'))
        throw new Error(`Hook ${hook.name} 失败: ${result.output}`);
    }
  }

  async execute(call: ToolCall, session: Session, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) throw new Error('已取消');
    const input = call.input;
    switch (call.name) {
      case 'search_repository':
      case 'list_snapshots':
      case 'restore_snapshot':
        return this.executor.execute(
          {
            requestId: randomUUID(),
            name: call.name,
            input: call.input,
            workspace: session.workspace,
            timeoutMs: 30_000,
            maxOutputBytes: 100_000,
          },
          signal,
        );
      case 'list_memory':
        return { output: JSON.stringify(this.store.listMemory(session.workspace)), isError: false };
      case 'remember_preference': {
        try {
          const preference = this.store.savePreference(session.id, String(input.content ?? ''));
          return { output: JSON.stringify(preference), isError: false };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message === '偏好必须是本轮用户明确表达的原文，且不能包含密钥' ||
            message === '用户偏好已达到 50 项上限'
          ) {
            return { output: message, isError: true };
          }
          throw error;
        }
      }
      case 'save_memory': {
        const key = String(input.key ?? '');
        const content = String(input.content ?? '');
        if (!/^[a-zA-Z0-9._-]{1,80}$/.test(key) || !content.trim() || content.length > 8000) {
          return { output: '记忆名称或内容无效', isError: true };
        }
        try {
          this.store.saveMemory(session.workspace, key, content);
          return { output: '工作区记忆已保存', isError: false };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === '工作区记忆已达到 50 项上限') {
            return { output: message, isError: true };
          }
          throw error;
        }
      }
      case 'create_task': {
        try {
          const task = this.store.createTask(
            session.id,
            String(input.title ?? ''),
            Array.isArray(input.dependencies) ? input.dependencies.map(String) : [],
            String(input.description ?? ''),
          );
          return { output: JSON.stringify(task), isError: false };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message === '无效任务' ||
            message === '工作区任务已达到 200 项上限' ||
            message === '依赖任务不存在或不属于当前工作区'
          ) {
            return { output: message, isError: true };
          }
          throw error;
        }
      }
      case 'list_tasks':
        return { output: JSON.stringify(this.store.listTasks(session.id)), isError: false };
      case 'get_task': {
        const task = this.store.getTask(session.id, String(input.id ?? ''));
        if (!task) return { output: '任务不存在或不属于当前工作区', isError: true };
        return { output: JSON.stringify(task), isError: false };
      }
      case 'update_task': {
        try {
          const task = this.store.updateTask(session.id, String(input.id ?? ''), {
            ...(typeof input.title === 'string' ? { title: input.title } : {}),
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
            ...(Array.isArray(input.addBlockedBy)
              ? { addBlockedBy: input.addBlockedBy.map(String) }
              : {}),
          });
          return { output: JSON.stringify(task), isError: false };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message === '任务不存在或不属于当前工作区' ||
            message === '没有任务修改内容' ||
            message === '无效任务内容' ||
            message === '无效依赖任务' ||
            message === '任务依赖已达到 30 项上限' ||
            message === '只能修改待执行任务的依赖' ||
            message === '依赖任务不存在或不属于当前工作区' ||
            message === '任务依赖会形成环'
          ) {
            return { output: message, isError: true };
          }
          throw error;
        }
      }
      case 'claim_task': {
        const task = this.claimReadyTask(session);
        return { output: JSON.stringify(task ?? null), isError: false };
      }
      case 'finish_task': {
        const id = String(input.id ?? '');
        if (!this.store.listTasks(session.id).some((task) => task.id === id)) {
          return { output: '任务不属于当前工作区', isError: true };
        }
        try {
          this.store.finishTask(id, this.taskOwner, input.success === true);
          this.claimedTasks.delete(id);
          return { output: '任务状态已保存', isError: false };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === '任务租约已失效或不属于当前进程') {
            return { output: message, isError: true };
          }
          throw error;
        }
      }
      case 'mcp_list_tools': {
        const server = loadConfig().mcpServers.find((item) => item.name === input.server);
        if (!server) return { output: 'MCP 服务器未配置', isError: true };
        const tools = await this.mcp.listTools(server, session.workspace);
        this.store.append(session.id, 'mcp_capabilities', {
          server: server.name,
          transport: server.transport,
          tools: tools.map((tool) => tool.name),
        });
        return {
          output: JSON.stringify(tools),
          isError: false,
        };
      }
      case 'mcp_call': {
        const server = loadConfig().mcpServers.find((item) => item.name === input.server);
        if (!server) return { output: 'MCP 服务器未配置', isError: true };
        return this.mcp.callTool(
          server,
          String(input.tool ?? ''),
          (input.arguments ?? {}) as Record<string, unknown>,
          session.workspace,
        );
      }
      case 'update_plan': {
        if (!planState(this.store.events(session.id)).enabled)
          return { output: '当前会话未开启规划模式', isError: true };
        const steps = input.steps;
        if (
          !Array.isArray(steps) ||
          !steps.length ||
          steps.length > 30 ||
          !steps.every((x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 500)
        )
          return { output: '规划需要 1 至 30 个有效步骤', isError: true };
        this.store.append(session.id, 'plan_updated', { steps });
        return { output: '规划已保存。等待用户在界面批准后才能执行修改。', isError: false };
      }
      case 'update_plan_progress': {
        if (!planState(this.store.events(session.id)).enabled)
          return { output: '当前会话未开启规划模式', isError: true };
        const state = setPlanProgress(
          this.store,
          session.id,
          Number(input.index),
          String(input.status) as 'pending' | 'in_progress' | 'completed',
        );
        return { output: JSON.stringify(state), isError: false };
      }
      case 'list_worktrees': {
        const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
          cwd: session.workspace,
          timeout: 10_000,
          maxBuffer: 100_000,
        });
        return { output: stdout, isError: false };
      }
      case 'create_worktree': {
        if (!fs.existsSync(session.workspace)) {
          return { output: '工作区目录不存在', isError: true };
        }
        const name =
          typeof input.name === 'string' && input.name
            ? input.name
            : `worktree-${randomUUID().slice(0, 8)}`;
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(name))
          return {
            output: '工作树名称必须以字母开头，仅包含小写字母、数字和连字符',
            isError: true,
          };
        const parent = path.join(dataDir(), 'worktrees');
        const destination = path.join(parent, name);
        if (fs.existsSync(destination)) return { output: '工作树名称已存在', isError: true };
        const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
          cwd: session.workspace,
          timeout: 10_000,
        });
        const root = fs.realpathSync(stdout.trim());
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        await execFileAsync('git', ['worktree', 'add', '--detach', destination, 'HEAD'], {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 100_000,
        });
        return { output: destination, isError: false };
      }
      case 'remove_worktree': {
        let destination: string;
        try {
          destination = fs.realpathSync(String(input.path ?? ''));
        } catch {
          return { output: '工作树路径不存在', isError: true };
        }
        const parent = path.join(dataDir(), 'worktrees');
        if (!fs.existsSync(parent)) {
          return { output: '只能移除 Bruin 管理的工作树', isError: true };
        }
        const parentReal = fs.realpathSync(parent);
        if (
          !destination.startsWith(parentReal + path.sep) ||
          path.dirname(destination) !== parentReal
        )
          return { output: '只能移除 Bruin 管理的工作树', isError: true };
        const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
          cwd: session.workspace,
          timeout: 10_000,
          maxBuffer: 100_000,
        });
        const destinationStat = fs.statSync(destination);
        const belongsToRepository = stdout.split(/\r?\n/).some((line) => {
          if (!line.startsWith('worktree ')) return false;
          const listedPath = line.slice('worktree '.length).trim();
          try {
            const listedReal = fs.realpathSync(listedPath);
            const pathMatches =
              process.platform === 'win32'
                ? listedReal.toLowerCase() === destination.toLowerCase()
                : listedReal === destination;
            if (pathMatches) return true;
            const listedStat = fs.statSync(listedPath);
            return (
              destinationStat.ino !== 0 &&
              listedStat.isDirectory() &&
              listedStat.dev === destinationStat.dev &&
              listedStat.ino === destinationStat.ino
            );
          } catch {
            return false;
          }
        });
        if (!belongsToRepository) return { output: '该路径不属于当前仓库的工作树', isError: true };
        await execFileAsync('git', ['worktree', 'remove', destination], {
          cwd: session.workspace,
          timeout: 30_000,
          maxBuffer: 100_000,
        });
        return { output: `已移除 ${destination}`, isError: false };
      }
      case 'spawn_subagent': {
        if ([...this.subagents.values()].filter((x) => x.status === 'running').length >= 2)
          return { output: '最多同时运行两个子 Agent', isError: true };
        const prompt = String(input.prompt ?? '').trim();
        if (!prompt || prompt.length > 10_000)
          return { output: '子 Agent 任务无效', isError: true };
        let workspace: string;
        try {
          workspace = input.worktree ? fs.realpathSync(String(input.worktree)) : session.workspace;
        } catch {
          return { output: '工作树路径不存在', isError: true };
        }
        if (input.worktree) {
          const parent = path.join(dataDir(), 'worktrees');
          if (!fs.existsSync(parent)) {
            return { output: '子 Agent 只能使用 Bruin 创建的工作树', isError: true };
          }
          const parentReal = fs.realpathSync(parent);
          if (!workspace.startsWith(parentReal + path.sep))
            return { output: '子 Agent 只能使用 Bruin 创建的工作树', isError: true };
        }
        const controller = new AbortController();
        const parentLease = this.sessionLeases.retain(session.id, controller);
        let child: Session;
        let childLease: ReturnType<SessionLeases['retain']> | undefined;
        try {
          child = this.store.createSession(workspace, session.profile);
          childLease = this.sessionLeases.retain(child.id, controller);
          this.store.append(session.id, 'subagent_started', {
            childId: child.id,
            prompt,
            workspace,
          });
        } catch (error) {
          try {
            childLease?.release();
          } finally {
            parentLease.release();
          }
          throw error;
        }
        this.subagents.set(child.id, { sessionId: child.id, controller, status: 'running' });
        const running = Promise.resolve()
          .then(() => this.runSubagent(child, prompt, controller.signal))
          .then(() => {
            const terminal = [...this.store.events(child.id)]
              .reverse()
              .find((event) => ['turn_paused', 'turn_completed'].includes(event.type));
            if (terminal?.type === 'turn_paused')
              throw new Error('子 Agent 已达到运行预算并暂停，任务尚未完成；请检查子会话后继续');
            const task = this.subagents.get(child.id);
            if (task) task.status = 'completed';
            this.store.append(session.id, 'subagent_finished', {
              childId: child.id,
              status: 'completed',
            });
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            const task = this.subagents.get(child.id);
            if (task) {
              task.status = 'failed';
              task.error = message;
            }
            this.store.append(session.id, 'subagent_finished', {
              childId: child.id,
              status: 'failed',
              error: message,
            });
          })
          .finally(() => {
            try {
              childLease!.release();
            } finally {
              parentLease.release();
            }
          });
        this.pending.add(running);
        void running.then(
          () => this.pending.delete(running),
          () => this.pending.delete(running),
        );
        return { output: `子 Agent 已启动: ${child.id}`, isError: false };
      }
      case 'subagent_status': {
        const id = String(input.id ?? '');
        if (
          !this.store
            .events(session.id)
            .some((e) => e.type === 'subagent_started' && e.payload.childId === id)
        )
          return { output: '子 Agent 不属于当前会话', isError: true };
        const child = this.subagents.get(id);
        const events = this.store.events(id);
        const ended = [...this.store.events(session.id)]
          .reverse()
          .find((e) => e.type === 'subagent_finished' && e.payload.childId === id);
        const state = child?.status ?? ended?.payload.status ?? 'unknown';
        const lastAnswer = [...events]
          .reverse()
          .find((e) => e.type === 'assistant' && typeof e.payload.text === 'string');
        return {
          output: JSON.stringify({
            id,
            status: state,
            answer: String(lastAnswer?.payload.text ?? '').slice(0, 20_000),
            error: child?.error ?? ended?.payload.error,
          }),
          isError: false,
        };
      }
      case 'start_background': {
        if ([...this.background.values()].filter((x) => x.status === 'running').length >= 2)
          return { output: '最多同时运行两个后台任务', isError: true };
        const command = String(input.command ?? '').trim();
        if (!command || command.length > 10_000) return { output: '后台命令无效', isError: true };
        if (session.managedWorkspace && !fs.existsSync(session.workspace)) {
          this.store.materializeWorkspace(session.id);
        }
        if (!fs.existsSync(session.workspace)) {
          return { output: '工作区目录不存在', isError: true };
        }
        const id = randomUUID();
        const controller = new AbortController();
        const lease = this.sessionLeases.retain(session.id, controller);
        try {
          this.store.append(session.id, 'background_started', { id, command });
        } catch (error) {
          lease.release();
          throw error;
        }
        this.background.set(id, { sessionId: session.id, controller, status: 'running' });
        const running = Promise.resolve()
          .then(() =>
            this.executor.execute(
              {
                requestId: id,
                name: 'shell',
                input: { command },
                workspace: fs.realpathSync(session.workspace),
                timeoutMs: 600_000,
                maxOutputBytes: 100_000,
              },
              controller.signal,
            ),
          )
          .then((result) => {
            const task = this.background.get(id);
            if (task) {
              if (task.status !== 'cancelled')
                task.status = result.isError ? 'failed' : 'completed';
              task.result = result;
            }
            this.store.append(session.id, 'background_finished', {
              id,
              status: task?.status,
              result,
            });
          })
          .catch((error) => {
            const task = this.background.get(id);
            if (task && task.status !== 'cancelled') task.status = 'failed';
            this.store.append(session.id, 'background_finished', {
              id,
              status: task?.status ?? 'failed',
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => lease.release());
        this.pending.add(running);
        void running.then(
          () => this.pending.delete(running),
          () => this.pending.delete(running),
        );
        return { output: `后台任务已启动: ${id}`, isError: false };
      }
      case 'background_status':
      case 'cancel_background': {
        const id = String(input.id ?? '');
        if (
          !this.store
            .events(session.id)
            .some((e) => e.type === 'background_started' && e.payload.id === id)
        )
          return { output: '后台任务不属于当前会话', isError: true };
        const task = this.background.get(id);
        if (call.name === 'cancel_background' && task?.status === 'running') {
          task.status = 'cancelled';
          task.controller.abort();
        }
        const finished = [...this.store.events(session.id)]
          .reverse()
          .find((e) => e.type === 'background_finished' && e.payload.id === id);
        return {
          output: JSON.stringify({
            id,
            status: task?.status ?? finished?.payload.status ?? 'unknown',
            result: task?.result ?? finished?.payload.result,
          }),
          isError: false,
        };
      }
      default:
        throw new Error('此工具不属于运行时服务');
    }
  }
  async close(): Promise<void> {
    clearInterval(this.taskHeartbeat);
    for (const id of this.claimedTasks) {
      try {
        this.store.releaseTask(id, this.taskOwner);
      } catch {
        /* Task may have already been finished or released. */
      }
    }
    this.claimedTasks.clear();
    for (const task of this.background.values())
      if (task.status === 'running') task.controller.abort();
    for (const task of this.subagents.values())
      if (task.status === 'running') task.controller.abort();
    await Promise.allSettled([...this.pending]);
    await this.mcp.close();
  }
}
