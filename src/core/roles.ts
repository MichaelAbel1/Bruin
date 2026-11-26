import type { ToolMode } from './tools.js';

export type AgentRole = 'explorer' | 'reviewer' | 'implementer' | 'verifier';

export interface RolePreset {
  id: AgentRole;
  label: string;
  description: string;
  defaultSubagentMode: 'read-only' | 'worktree';
  toolMode: ToolMode;
  defaultMaxSteps: number;
  scope: string;
  deliverable: string;
  instruction: string;
}

export const agentRoles: Record<AgentRole, RolePreset> = {
  explorer: {
    id: 'explorer',
    label: '只读探索',
    description: '快速定位相关文件、符号与调用链，不修改代码。',
    defaultSubagentMode: 'read-only',
    toolMode: 'read-only',
    defaultMaxSteps: 12,
    scope: 'Read-only codebase exploration and architecture mapping.',
    deliverable: 'Concise list of relevant files, line ranges, key interfaces, and verified facts.',
    instruction:
      'Role: Explorer. Use only read-only discovery tools (search_repository, search, list_files, read_file). Do not propose speculative edits without citing exact file paths and lines.',
  },
  reviewer: {
    id: 'reviewer',
    label: '代码审查',
    description: '只读审计正确性、安全边界、并发风险与测试覆盖。',
    defaultSubagentMode: 'read-only',
    toolMode: 'read-only',
    defaultMaxSteps: 12,
    scope: 'Read-only code review for defects, security risks, edge cases, and test gaps.',
    deliverable:
      'Prioritized findings with severity, file:line evidence, concrete reproduction, minimal fix, and unverified areas.',
    instruction:
      'Role: Code Reviewer. Focus strictly on real, verifiable bugs, regressions, security flaws, and missing tests. Cite exact file paths and line numbers for every finding.',
  },
  implementer: {
    id: 'implementer',
    label: '聚焦编码',
    description: '在明确边界内执行最小改动并验证。',
    defaultSubagentMode: 'worktree',
    toolMode: 'worktree',
    defaultMaxSteps: 20,
    scope: 'Minimal, focused implementation within the requested files and module boundaries.',
    deliverable:
      'Summary of modified files, exact verification commands run, and any residual risks.',
    instruction:
      'Role: Focused Implementer. Read existing code before editing, keep changes minimal and consistent with project conventions, and verify with targeted checks or tests.',
  },
  verifier: {
    id: 'verifier',
    label: '验证测试',
    description: '运行构建、静态检查与测试并报告客观结果。',
    defaultSubagentMode: 'worktree',
    toolMode: 'verifier',
    defaultMaxSteps: 12,
    scope: 'Build, typecheck, and test verification without unrelated code modifications.',
    deliverable: 'Exact commands executed, pass/fail counts, failing stack traces or root causes.',
    instruction:
      'Role: Verifier. Inspect code and execute build, typecheck, lint, or test commands to verify behavior objectively. Never weaken assertions or skip tests to make checks pass.',
  },
};

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && Object.hasOwn(agentRoles, value);
}

export function rolePreset(role: AgentRole): RolePreset {
  return agentRoles[role];
}
