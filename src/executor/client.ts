import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ToolRequest, ToolResponse, ToolResult } from '../core/types.js';

export interface ToolExecutor {
  execute(request: ToolRequest, signal?: AbortSignal): Promise<ToolResult>;
  close(): Promise<void>;
}
export class ProcessExecutor implements ToolExecutor {
  private child: ChildProcess;
  private pending = new Map<
    string,
    { resolve: (value: ToolResult) => void; reject: (reason: Error) => void }
  >();
  constructor() {
    const worker = fileURLToPath(new URL('./worker.js', import.meta.url));
    this.child = fork(worker, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        BRUIN_ALLOW_UNSANDBOXED_SHELL: process.env.BRUIN_ALLOW_UNSANDBOXED_SHELL,
        BRUIN_SHELL_BACKEND: process.env.BRUIN_SHELL_BACKEND,
        BRUIN_DOCKER_IMAGE: process.env.BRUIN_DOCKER_IMAGE,
        BRUIN_DOCKER_CONFIG: process.env.BRUIN_DOCKER_CONFIG,
        DOCKER_HOST: process.env.DOCKER_HOST,
      },
    });
    this.child.on('message', (raw: ToolResponse) => {
      const p = this.pending.get(raw.requestId);
      if (p) {
        this.pending.delete(raw.requestId);
        p.resolve(raw.result);
      }
    });
    this.child.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('工具执行进程退出，结果未知'));
      this.pending.clear();
    });
  }
  execute(request: ToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    if (!this.child.connected) return Promise.reject(new Error('工具执行进程未连接'));
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('已取消'));
      const abort = () => this.child.send({ type: 'cancel', requestId: request.requestId });
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(request.requestId, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', abort);
          reject(err);
        },
      });
      this.child.send(request, (err) => {
        if (err) {
          this.pending.delete(request.requestId);
          reject(err);
        }
      });
    });
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    if (this.child.connected) this.child.disconnect();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
