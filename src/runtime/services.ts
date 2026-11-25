import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MemoryPageChangedError,
  type EventStore,
  type MemoryPage,
  type TaskNode,
} from '../storage/event-store.js';
import type { ToolExecutor } from '../executor/client.js';
import type { Session, SessionEvent, ToolCall, ToolResult } from '../core/types.js';
import { dataDir, loadConfig, type HookConfig, type McpServerConfig } from '../config.js';
import { McpManager } from './mcp.js';
import { planState, setPlanProgress } from './plan.js';
import { SessionLeases } from '../core/session-leases.js';
import { listWorkspaceChanges, readWorkspaceReview } from '../core/workspace-review.js';
import { buildWorkspacePatch, preflightWorkspacePatches } from '../core/workspace-patch.js';
import type { SubagentOptions } from './subagent.js';
import { onSteeringInput, pendingInputs } from '../core/input-queue.js';
import { originalSubagentTurn } from '../core/subagent-results.js';

const execFileAsync = promisify(execFile);
type Background = {
  sessionId: string;
  controller: AbortController;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: ToolResult;
};
type Subagent = {
  parentSessionId: string;
  controller: AbortController;
  settled: Promise<void>;
};
type DelegationSettings = {
  toolStartedSeq?: number;
  expectedMemoryPage?: MemoryPage | null;
  allowWorkspaceEdits?: boolean;
  maxModelCalls?: number;
  maxDurationMs?: number;
  worktreeBase?: { repository: string; commit: string };
};

export class RuntimeServices {
  readonly mcp: McpManager;
  configuredMcpServers(): McpServerConfig[] {
    return this.sessionMcp?.servers ?? loadConfig().mcpServers;
  }
  readonly sessionLeases: SessionLeases;
  private readonly taskOwner = randomUUID();
  private readonly claimedTasks = new Set<string>();
  private readonly taskHeartbeat: ReturnType<typeof setInterval>;
  private background = new Map<string, Background>();
  private subagents = new Map<string, Subagent>();
  private startingSubagents = 0;
  private startingSubagentWork = new Map<AbortController, Promise<void>>();
  private closing = false;
  private patchPreflight?: AbortController;
  private pending = new Set<Promise<unknown>>();
  private subagentDelegation(events: SessionEvent[], childId: string) {
    return events.find(
      (event) => event.type === 'subagent_started' && event.payload.childId === childId,
    );
  }
  private subagentWorktree(started: SessionEvent) {
    const workspace = String(started.payload.workspace ?? '');
    if (fs.realpathSync(workspace) !== workspace) throw new Error('子 Agent 工作树路径已改变');
    return { workspace, baseCommit: String(started.payload.baseCommit ?? '') };
  }
  listSubagentPatches(parentId: string) {
    return this.store
      .events(parentId)
      .filter((event) => event.type === 'subagent_started' && event.payload.mode === 'worktree')
      .map(({ payload }) => {
        const id = String(payload.childId);
        return {
          id,
          prompt: String(payload.prompt ?? '').slice(0, 160),
          baseCommit: String(payload.baseCommit ?? ''),
          running: this.store.isLeased(id),
        };
      })
      .reverse();
  }
  private subagentPatchSource(events: SessionEvent[], childId: string) {
    const started = this.subagentDelegation(events, childId);
    if (!started) throw new Error('子 Agent 不属于当前会话');
    if (started.payload.mode !== 'worktree') throw new Error('只读子 Agent 没有可导出的工作树');
    if (this.store.isLeased(childId)) throw new Error('请等子 Agent 结束后再导出补丁');
    return this.subagentWorktree(started);
  }
  private async buildSubagentPatch(
    childId: string,
    { workspace, baseCommit }: { workspace: string; baseCommit: string },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const lease = this.store.getSession(childId)
      ? new SessionLeases(this.store).retain(childId, controller)
      : undefined;
    try {
      return await buildWorkspacePatch(
        workspace,
        this.store.events(childId),
        baseCommit,
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      );
    } finally {
      lease?.release();
    }
  }
  async exportSubagentPatch(parentId: string, childId: string) {
    if (this.closing) throw new Error('运行时正在关闭');
    const source = this.subagentPatchSource(this.store.events(parentId), childId);
    const settled = this.buildSubagentPatch(childId, source);
    this.pending.add(settled);
    try {
      return { baseCommit: source.baseCommit, contentBase64: (await settled).toString('base64') };
    } finally {
      this.pending.delete(settled);
    }
  }
  async preflightSubagentPatches(session: Session, childIds: string[], testCommand?: string) {
    if (this.closing) throw new Error('运行时正在关闭');
    if (this.patchPreflight) throw new Error('已有联合预检正在运行');
    if (childIds.length < 2 || childIds.length > 10 || new Set(childIds).size !== childIds.length)
      throw new Error('请选择 2 至 10 个不同的子任务');
    const events = this.store.events(session.id);
    const sources = childIds.map((id) => this.subagentPatchSource(events, id));
    const { baseCommit } = sources[0];
    if (sources.some((source) => source.baseCommit !== baseCommit))
      throw new Error('联合预检要求所有子任务使用同一个启动提交');
    const controller = new AbortController();
    this.patchPreflight = controller;
    const checkWorkspace = () => {
      if (this.store.getSession(session.id)?.workspace !== session.workspace)
        throw new Error('会话工作区已改变，请重新预检');
    };
    const runTest = testCommand
      ? (workspace: string) => {
          checkWorkspace();
          return this.executor.execute(
            {
              requestId: randomUUID(),
              name: 'shell',
              input: { command: testCommand },
              workspace,
              timeoutMs: 120_000,
              maxOutputBytes: 100_000,
              requireSandbox: true,
              workspaceOnlyWrites: true,
            },
            controller.signal,
          );
        }
      : undefined;
    const settled = (async () => {
      const patches = [];
      for (const [index, childId] of childIds.entries()) {
        const source = sources[index];
        patches.push({
          childId,
          workspace: source.workspace,
          content: await this.buildSubagentPatch(childId, source, controller.signal),
        });
      }
      return preflightWorkspacePatches(
        session.workspace,
        baseCommit,
        patches,
        controller.signal,
        runTest,
      );
    })();
    this.pending.add(settled);
    try {
      const result = await settled;
      checkWorkspace();
      return result;
    } finally {
      this.pending.delete(settled);
      this.patchPreflight = undefined;
    }
  }
  private recordSubagentResult(
    parentSessionId: string,
    childId: string,
    payload: {
      status: 'completed' | 'failed';
      workspace: string;
      mode: SubagentOptions['mode'];
      baseCommit?: string;
      answer?: string;
      error?: string;
    },
  ): void {
    const recorded = this.store
      .events(parentSessionId)
      .some((event) => event.type === 'subagent_finished' && event.payload.childId === childId);
    if (!recorded) this.store.append(parentSessionId, 'subagent_finished', { childId, ...payload });
  }
  async waitForSubagents(
    sessionId: string,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<void> {
    const tasks = [...this.subagents.values()].filter((task) => task.parentSessionId === sessionId);
    if (!tasks.length) return;
    if (signal.aborted) throw new Error('已取消');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    let unsubscribe: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(new Error('已取消'));
        timer = timeoutMs === undefined ? undefined : setTimeout(resolve, Math.max(0, timeoutMs));
        signal.addEventListener('abort', abort, { once: true });
        unsubscribe = onSteeringInput(this.store, sessionId, resolve);
        if (pendingInputs(this.store.events(sessionId)).some((input) => input.mode === 'steer'))
          resolve();
        // A failed receipt must not let the parent shut down still-running siblings.
        void Promise.allSettled(tasks.map((task) => task.settled)).then((results) => {
          const failure = results.find((result) => result.status === 'rejected');
          if (failure) reject(failure.reason);
          else resolve();
        });
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      unsubscribe?.();
    }
  }
  constructor(
    private store: EventStore,
    private executor: ToolExecutor,
    private runSubagent: (
      session: Session,
      prompt: string,
      signal: AbortSignal,
      options: SubagentOptions,
    ) => Promise<void>,
    private sessionMcp?: {
      servers: McpServerConfig[];
      env: Record<string, Record<string, string>>;
    },
  ) {
    this.mcp = new McpManager(sessionMcp?.env);
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

  async runHooks(
    event: HookConfig['event'],
    session: Session,
    signal: AbortSignal,
    hooks: readonly HookConfig[] = loadConfig().hooks,
  ): Promise<void> {
    if (signal.aborted) throw new Error('已取消');
    if (session.managedWorkspace && !fs.existsSync(session.workspace)) return;
    if (!fs.existsSync(session.workspace)) throw new Error('工作区目录不存在');
    for (const hook of hooks.filter((item) => item.enabled && item.event === event)) {
      if (signal.aborted) throw new Error('已取消');
      let result: ToolResult;
      try {
        result = await this.executor.execute(
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
      } catch (error) {
        this.store.append(session.id, 'hook_finished', {
          name: hook.name,
          event,
          isError: true,
          executionUnknown: true,
          output:
            `Hook 执行未返回确定结果：${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              10_000,
            ),
        });
        throw error;
      }
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

  async execute(
    call: ToolCall,
    session: Session,
    signal: AbortSignal,
    delegation: DelegationSettings = {},
  ): Promise<ToolResult> {
    if (signal.aborted) throw new Error('已取消');
    if (this.closing && ['spawn_subagent', 'start_background'].includes(call.name))
      return { output: '运行时正在关闭，不能启动新任务', isError: true };
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
          this.store.saveMemory(session.workspace, key, content, delegation.expectedMemoryPage);
          return { output: '工作区记忆已保存', isError: false };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof MemoryPageChangedError || message === '工作区记忆已达到 50 项上限') {
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
        const server = this.configuredMcpServers().find((item) => item.name === input.server);
        if (!server) return { output: 'MCP 服务器未配置', isError: true };
        const tools = await this.mcp.listTools(server, session.workspace, signal);
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
        const server = this.configuredMcpServers().find((item) => item.name === input.server);
        if (!server) return { output: 'MCP 服务器未配置', isError: true };
        return this.mcp.callTool(
          server,
          String(input.tool ?? ''),
          (input.arguments ?? {}) as Record<string, unknown>,
          session.workspace,
          signal,
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
          signal,
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
        const base = delegation.worktreeBase;
        const root =
          base?.repository ??
          fs.realpathSync.native(
            (
              await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
                cwd: session.workspace,
                timeout: 10_000,
                signal,
              })
            ).stdout.trim(),
          );
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        await execFileAsync(
          'git',
          ['worktree', 'add', '--detach', destination, base?.commit ?? 'HEAD'],
          { cwd: root, timeout: 30_000, maxBuffer: 100_000, signal },
        );
        return { output: destination, isError: false };
      }
      case 'remove_worktree': {
        let destination: string;
        try {
          destination = fs.realpathSync.native(String(input.path ?? ''));
        } catch {
          return { output: '工作树路径不存在', isError: true };
        }
        const parent = path.join(dataDir(), 'worktrees');
        if (!fs.existsSync(parent)) {
          return { output: '只能移除 Bruin 管理的工作树', isError: true };
        }
        const parentReal = fs.realpathSync.native(parent);
        if (
          !destination.startsWith(parentReal + path.sep) ||
          path.dirname(destination) !== parentReal
        )
          return { output: '只能移除 Bruin 管理的工作树', isError: true };
        const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
          cwd: session.workspace,
          timeout: 10_000,
          maxBuffer: 100_000,
          signal,
        });
        const destinationStat = fs.statSync(destination);
        const belongsToRepository = stdout.split(/\r?\n/).some((line) => {
          if (!line.startsWith('worktree ')) return false;
          const listedPath = line.slice('worktree '.length).trim();
          try {
            const listedReal = fs.realpathSync.native(listedPath);
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
        if (
          this.store.listSessions().some((item) => {
            if (!this.store.isLeased(item.id)) return false;
            const workspace = fs.existsSync(item.workspace)
              ? fs.realpathSync.native(item.workspace)
              : item.workspace;
            const relative = path.relative(destination, workspace);
            return (
              !path.isAbsolute(relative) &&
              relative !== '..' &&
              !relative.startsWith('..' + path.sep)
            );
          })
        )
          return { output: '工作树仍有运行中的会话，不能移除', isError: true };
        await execFileAsync('git', ['worktree', 'remove', destination], {
          cwd: session.workspace,
          timeout: 30_000,
          maxBuffer: 100_000,
          signal,
        });
        return { output: `已移除 ${destination}`, isError: false };
      }
      case 'spawn_subagent': {
        if (this.startingSubagents + this.subagents.size >= 2)
          return { output: '最多同时运行两个子 Agent', isError: true };
        this.startingSubagents++;
        try {
          const prompt = String(input.prompt ?? '').trim();
          if (!prompt || prompt.length > 10_000)
            return { output: '子 Agent 任务无效', isError: true };
          const mode = input.mode === 'worktree' ? 'worktree' : 'read-only';
          const config = loadConfig();
          if (
            mode === 'worktree' &&
            !delegation.allowWorkspaceEdits &&
            config.approvalMode !== 'auto'
          )
            return {
              output: '可写子 Agent 需要父任务已授权文件写入；请开启本段工作区文件写入授权后再启动',
              isError: true,
            };
          if (mode === 'worktree' && input.worktree)
            return { output: '可写子 Agent 自动创建独立工作树，不能复用指定路径', isError: true };
          let workspace: string;
          try {
            workspace = input.worktree
              ? fs.realpathSync.native(String(input.worktree))
              : session.workspace;
          } catch {
            return { output: '工作树路径不存在', isError: true };
          }
          if (input.worktree) {
            const parent = path.join(dataDir(), 'worktrees');
            if (!fs.existsSync(parent)) {
              return { output: '子 Agent 只能使用 Bruin 创建的工作树', isError: true };
            }
            const parentReal = fs.realpathSync.native(parent);
            if (!workspace.startsWith(parentReal + path.sep))
              return { output: '子 Agent 只能使用 Bruin 创建的工作树', isError: true };
            const workspaceStat = fs.statSync(workspace);
            if (!workspaceStat.isDirectory())
              return { output: '工作树路径不是目录', isError: true };
            let worktreeOutput: string;
            try {
              worktreeOutput = (
                await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
                  cwd: session.workspace,
                  timeout: 10_000,
                  maxBuffer: 100_000,
                  signal,
                })
              ).stdout;
            } catch {
              return { output: '该路径不属于当前仓库的工作树', isError: true };
            }
            const belongsToRepo = worktreeOutput.split(/\r?\n/).some((line) => {
              if (!line.startsWith('worktree ')) return false;
              const listedPath = line.slice('worktree '.length).trim();
              try {
                const listedReal = fs.realpathSync.native(listedPath);
                const pathMatches =
                  process.platform === 'win32'
                    ? listedReal.toLowerCase() === workspace.toLowerCase() ||
                      workspace.toLowerCase().startsWith(listedReal.toLowerCase() + path.sep)
                    : listedReal === workspace || workspace.startsWith(listedReal + path.sep);
                if (pathMatches) return true;
                const listedStat = fs.statSync(listedPath);
                return (
                  workspaceStat.ino !== 0 &&
                  listedStat.isDirectory() &&
                  listedStat.dev === workspaceStat.dev &&
                  listedStat.ino === workspaceStat.ino
                );
              } catch {
                return false;
              }
            });
            if (!belongsToRepo) return { output: '该路径不属于当前仓库的工作树', isError: true };
          }
          const childOptions: SubagentOptions = {
            mode,
            commands: config.approvedCommands
              .filter(
                (rule) =>
                  rule.workspace === session.workspace &&
                  (!rule.sessionId || rule.sessionId === session.id),
              )
              .map((rule) => rule.command),
            autoSafeShell: config.approvalMode === 'autoSafe' || config.approvalMode === 'auto',
            maxModelCalls: delegation.maxModelCalls ?? 24,
            maxDurationMs: delegation.maxDurationMs ?? 30 * 60_000,
          };
          const controller = new AbortController();
          const parentLease = this.sessionLeases.retain(session.id, controller);
          let setupFinished!: () => void;
          this.startingSubagentWork.set(
            controller,
            new Promise<void>((resolve) => {
              setupFinished = resolve;
            }),
          );
          let child: Session;
          let childLease: ReturnType<SessionLeases['retain']> | undefined;
          let baseCommit: string | undefined;
          let worktreeRoot: string | undefined;
          let setupComplete = false;
          const abortSetup = () => controller.abort();
          signal.addEventListener('abort', abortSetup, { once: true });
          try {
            if (signal.aborted || controller.signal.aborted) throw new Error('已取消');
            if (mode === 'worktree') {
              const gitOptions = {
                cwd: session.workspace,
                timeout: 10_000,
                signal: controller.signal,
              };
              const { stdout } = await execFileAsync(
                'git',
                ['rev-parse', '--show-toplevel', '--verify', 'HEAD^{commit}'],
                gitOptions,
              );
              const revision = stdout.trimEnd();
              const separator = revision.lastIndexOf('\n');
              if (separator < 0) throw new Error('无法识别子 Agent 的启动提交');
              const repository = fs.realpathSync.native(
                revision.slice(0, separator).replace(/\r$/, ''),
              );
              baseCommit = revision.slice(separator + 1);
              const scope = path.relative(repository, fs.realpathSync.native(session.workspace));
              if (path.isAbsolute(scope) || scope === '..' || scope.startsWith('..' + path.sep))
                return { output: '子任务的工作区不在当前仓库内', isError: true };
              if (scope) {
                const { stdout: entry } = await execFileAsync(
                  'git',
                  [
                    'ls-tree',
                    '-z',
                    '--full-tree',
                    baseCommit,
                    '--',
                    ':(literal)' + scope.split(path.sep).join('/'),
                  ],
                  { ...gitOptions, cwd: repository },
                );
                if (!entry.startsWith('040000 tree '))
                  return {
                    output: `子任务的启动提交 ${baseCommit.slice(0, 12)} 中没有工作区目录 ${scope}，请在包含该目录的提交上重试`,
                    isError: true,
                  };
              }
              const created = await this.execute(
                {
                  id: randomUUID(),
                  name: 'create_worktree',
                  input: { name: `agent-${randomUUID().slice(0, 12)}` },
                },
                session,
                controller.signal,
                { worktreeBase: { repository, commit: baseCommit } },
              );
              if (created.isError) throw new Error(created.output);
              worktreeRoot = created.output;
              const expected = path.join(fs.realpathSync.native(worktreeRoot), scope);
              workspace = fs.realpathSync.native(expected);
              if (path.relative(expected, workspace) || !fs.statSync(workspace).isDirectory())
                throw new Error('子任务的工作区与启动提交中的目录不一致');
            }
            if (controller.signal.aborted) throw new Error('已取消');
            child = this.store.createSession(workspace, session.profile);
            childLease = this.sessionLeases.retain(child.id, controller);
            this.store.append(session.id, 'subagent_started', {
              childId: child.id,
              toolStartedSeq: delegation.toolStartedSeq,
              prompt,
              workspace,
              mode,
              baseCommit,
              permissions: {
                fileEdits: mode === 'worktree',
                commands: childOptions.commands,
                autoSafeShell: childOptions.autoSafeShell,
              },
              budget: {
                maxModelCalls: childOptions.maxModelCalls,
                maxDurationMs: childOptions.maxDurationMs,
              },
            });
            setupComplete = true;
          } catch (error) {
            if (worktreeRoot && fs.existsSync(worktreeRoot)) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(`${message}\n工作树保留在 ${worktreeRoot}。`, { cause: error });
            }
            throw error;
          } finally {
            signal.removeEventListener('abort', abortSetup);
            this.startingSubagentWork.delete(controller);
            setupFinished();
            if (!setupComplete) {
              try {
                childLease?.release();
              } finally {
                parentLease.release();
              }
            }
          }
          const running = Promise.resolve()
            .then(async () => {
              let failure: string | undefined;
              try {
                if (controller.signal.aborted) throw new Error('已取消');
                await this.runSubagent(child, prompt, controller.signal, childOptions);
                if (controller.signal.aborted) throw new Error('已取消');
              } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
              }
              const { terminal, answer } = originalSubagentTurn(this.store.events(child.id));
              if (failure === undefined && terminal?.type !== 'turn_completed')
                failure =
                  terminal?.type === 'turn_paused'
                    ? '子 Agent 已达到运行预算并暂停，任务尚未完成；请检查子会话后继续'
                    : '子 Agent 未正常完成，未记录回合完成事件；请检查子会话';
              const verifyLeases = () => {
                if (
                  !this.store.renewLease(session.id, parentLease.owner, 30_000) ||
                  !this.store.renewLease(child.id, childLease!.owner, 30_000)
                )
                  throw new Error('子任务租约已失效，请从子会话恢复结果');
              };
              const record = () =>
                this.recordSubagentResult(session.id, child.id, {
                  status: failure === undefined ? 'completed' : 'failed',
                  error: failure,
                  workspace,
                  mode,
                  baseCommit,
                  answer,
                });
              verifyLeases();
              try {
                record();
              } catch {
                // The write may have committed before throwing. Retry the same idempotent receipt.
                verifyLeases();
                record();
              }
            })
            .finally(() => {
              this.subagents.delete(child.id);
              try {
                childLease!.release();
              } finally {
                parentLease.release();
              }
            });
          this.subagents.set(child.id, {
            parentSessionId: session.id,
            controller,
            settled: running,
          });
          this.pending.add(running);
          void running.then(
            () => this.pending.delete(running),
            () => this.pending.delete(running),
          );
          return { output: `子 Agent 已启动: ${child.id}`, isError: false };
        } finally {
          this.startingSubagents--;
        }
      }
      case 'subagent_status':
      case 'subagent_review':
      case 'cancel_subagent': {
        const id = String(input.id ?? '');
        const parentEvents = this.store.events(session.id);
        const started = this.subagentDelegation(parentEvents, id);
        if (!started) return { output: '子 Agent 不属于当前会话', isError: true };
        const child = this.subagents.get(id);
        const ended =
          call.name === 'subagent_review'
            ? undefined
            : parentEvents
                .reverse()
                .find(
                  (event) => event.type === 'subagent_finished' && event.payload.childId === id,
                );
        if (call.name === 'cancel_subagent' && !ended) {
          if (!child)
            return {
              output: this.store.isLeased(id)
                ? '当前进程无法取消此子 Agent。子会话仍持有租约，请在启动它的进程中取消。'
                : '未找到可取消的子 Agent 运行，且缺少完成记录，请检查子会话。',
              isError: true,
            };
          child.controller.abort();
        }
        const events = this.store.events(id);
        const workspace = String(started.payload.workspace ?? '');
        let changes: ReturnType<typeof listWorkspaceChanges> | undefined;
        let reviewError: string | undefined;
        if (started.payload.mode === 'worktree') {
          try {
            const { baseCommit } = this.subagentWorktree(started);
            if (call.name === 'subagent_review')
              return {
                output: JSON.stringify(
                  readWorkspaceReview(workspace, String(input.path ?? ''), events, baseCommit),
                ),
                isError: false,
              };
            changes = listWorkspaceChanges(workspace, events, baseCommit);
          } catch (error) {
            reviewError = error instanceof Error ? error.message : String(error);
          }
        }
        if (call.name === 'subagent_review')
          return { output: reviewError ?? '只读子 Agent 没有可审核的工作树改动', isError: true };
        const state = ended?.payload.status ?? (child ? 'running' : 'unknown');
        const original = originalSubagentTurn(events);
        const originalAnswer =
          original.user && original.user.payload.text !== started.payload.prompt
            ? ''
            : original.answer;
        return {
          output: JSON.stringify({
            id,
            status: state,
            answer: String(ended?.payload.answer ?? originalAnswer).slice(0, 20_000),
            error: ended?.payload.error,
            workspace,
            mode: started.payload.mode ?? 'read-only',
            baseCommit: started.payload.baseCommit,
            changes: changes?.slice(0, 300),
            changesTruncated: changes ? changes.length > 300 : undefined,
            reviewError,
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
          .then(() => {
            if (controller.signal.aborted) throw new Error('已取消');
            return this.executor.execute(
              {
                requestId: id,
                name: 'shell',
                input: { command },
                workspace: fs.realpathSync(session.workspace),
                timeoutMs: 600_000,
                maxOutputBytes: 100_000,
              },
              controller.signal,
            );
          })
          .then((result) => {
            const task = this.background.get(id);
            if (task) {
              task.status = controller.signal.aborted
                ? 'cancelled'
                : result.isError
                  ? 'failed'
                  : 'completed';
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
            if (task) task.status = controller.signal.aborted ? 'cancelled' : 'failed';
            this.store.append(session.id, 'background_finished', {
              id,
              status: task?.status ?? 'failed',
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            this.background.delete(id);
            lease.release();
          });
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
            ...(finished?.payload.error !== undefined ? { error: finished.payload.error } : {}),
          }),
          isError: false,
        };
      }
      default:
        throw new Error('此工具不属于运行时服务');
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    this.patchPreflight?.abort();
    for (const controller of this.startingSubagentWork.keys()) controller.abort();
    await Promise.allSettled([...this.startingSubagentWork.values()]);
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
    for (const task of this.subagents.values()) task.controller.abort();
    await Promise.allSettled([...this.pending]);
    await this.mcp.close();
  }
}
