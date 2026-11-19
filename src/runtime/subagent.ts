import { AgentRunner } from '../core/agent.js';
import { isAutoSafeShell, isMaliciousShell } from '../core/approval-policy.js';
import type { ToolMode } from '../core/tools.js';
import type { Session } from '../core/types.js';
import type { ToolExecutor } from '../executor/client.js';
import { AiSdkGateway, type ModelGateway } from '../providers/gateway.js';
import type { EventStore } from '../storage/event-store.js';

export type SubagentOptions = {
  mode: 'read-only' | 'worktree';
  commands: readonly string[];
  autoSafeShell: boolean;
  maxModelCalls: number;
  maxDurationMs: number;
};

/** Shared by CLI, desktop and ACP; child permissions never prompt or grow. */
export function createSubagentRunner(
  store: EventStore,
  executor: ToolExecutor,
  gateway: (mode: ToolMode) => ModelGateway = (mode) => new AiSdkGateway(mode),
) {
  return (session: Session, prompt: string, signal: AbortSignal, options: SubagentOptions) => {
    const writable = options.mode === 'worktree';
    return new AgentRunner(
      store,
      gateway(options.mode),
      executor,
      {
        text() {},
        notice() {},
        async approve(call) {
          if (!writable) return false;
          if (call.name === 'write_file' || call.name === 'edit_file') return true;
          if (call.name === 'shell' && typeof call.input.command === 'string') {
            const command = call.input.command.trim();
            return (
              !isMaliciousShell(command) &&
              (options.commands.includes(command) ||
                (options.autoSafeShell && isAutoSafeShell(command)))
            );
          }
          return false;
        },
      },
      undefined,
      !writable,
      writable,
    ).run(session, prompt, signal, [], undefined, {
      maxModelCalls: options.maxModelCalls,
      maxDurationMs: options.maxDurationMs,
      checkpointEvery: 24,
      unattended: true,
    });
  };
}
