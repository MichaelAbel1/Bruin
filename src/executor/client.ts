import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ToolRequest, ToolResponse, ToolResult } from '../core/types.js';

export interface ToolExecutor {
  execute(request: ToolRequest, signal?: AbortSignal): Promise<ToolResult>;
  close(): Promise<void>;
}
interface WorkerInstance {
  child: ChildProcess;
  pending: Map<string, { resolve: (value: ToolResult) => void; reject: (reason: Error) => void }>;
}

export class ProcessExecutor implements ToolExecutor {
  private currentWorker!: WorkerInstance;
  private workers = new Set<WorkerInstance>();
  private closing = false;

  get child(): ChildProcess {
    return this.currentWorker.child;
  }

  constructor() {
    this.spawnWorker();
  }

  private spawnWorker(): WorkerInstance {
    const worker = fileURLToPath(new URL('./worker.js', import.meta.url));
    const child = fork(worker, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        BRUIN_ALLOW_UNSANDBOXED_SHELL: process.env.BRUIN_ALLOW_UNSANDBOXED_SHELL,
        BRUIN_ENFORCE_SANDBOX: process.env.BRUIN_ENFORCE_SANDBOX,
        BRUIN_SHELL_BACKEND: process.env.BRUIN_SHELL_BACKEND,
        BRUIN_DOCKER_IMAGE: process.env.BRUIN_DOCKER_IMAGE,
        BRUIN_DOCKER_CONFIG: process.env.BRUIN_DOCKER_CONFIG,
        DOCKER_HOST: process.env.DOCKER_HOST,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        PATHEXT: process.env.PATHEXT,
      },
    });

    const pending = new Map<
      string,
      { resolve: (value: ToolResult) => void; reject: (reason: Error) => void }
    >();
    const instance: WorkerInstance = { child, pending };
    this.workers.add(instance);
    this.currentWorker = instance;

    child.on('message', (raw: ToolResponse) => {
      const p = pending.get(raw.requestId);
      if (p) {
        pending.delete(raw.requestId);
        p.resolve(raw.result);
      }
    });

    child.on('error', (err) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });

    child.on('exit', () => {
      this.workers.delete(instance);
      for (const p of pending.values()) p.reject(new Error('工具执行进程退出，结果未知'));
      pending.clear();
    });

    return instance;
  }

  private isAlive(child: ChildProcess): boolean {
    return child.connected && !child.killed && child.exitCode === null && child.signalCode === null;
  }

  execute(request: ToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    if (this.closing) return Promise.reject(new Error('工具执行器已关闭'));
    if (!this.isAlive(this.currentWorker.child)) this.spawnWorker();
    const worker = this.currentWorker;
    if (!this.isAlive(worker.child)) return Promise.reject(new Error('工具执行进程未连接'));
    if (!request.requestId || worker.pending.has(request.requestId))
      return Promise.reject(new Error('工具请求 ID 为空或仍在执行'));

    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('已取消'));
      const abort = () => {
        try {
          if (worker.child.connected)
            worker.child.send({ type: 'cancel', requestId: request.requestId }, () => {});
        } catch {}
      };
      signal?.addEventListener('abort', abort, { once: true });
      const pending: { resolve: (value: ToolResult) => void; reject: (reason: Error) => void } = {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', abort);
          reject(err);
        },
      };
      worker.pending.set(request.requestId, pending);
      worker.child.send(request, (err) => {
        if (err) {
          if (worker.pending.get(request.requestId) === pending)
            worker.pending.delete(request.requestId);
          signal?.removeEventListener('abort', abort);
          reject(err);
        }
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const exitPromises: Promise<void>[] = [];
    for (const worker of this.workers) {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) continue;
      const exited = new Promise<void>((resolve) => worker.child.once('exit', () => resolve()));
      if (worker.child.connected) worker.child.disconnect();
      const timer = setTimeout(() => worker.child.kill('SIGKILL'), 12000);
      timer.unref();
      exitPromises.push(exited.finally(() => clearTimeout(timer)));
    }
    await Promise.all(exitPromises);
  }
}
