export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible';
export type ToolName = keyof typeof import('./tools.js').toolDefinitions;
export interface ModelProfile {
  alias: string;
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
}
export interface ToolCall {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
}
export type EventType =
  | 'user'
  | 'assistant'
  | 'tool_requested'
  | 'tool_approved'
  | 'tool_denied'
  | 'tool_started'
  | 'tool_finished'
  | 'tool_unknown'
  | 'turn_completed'
  | 'turn_paused'
  | 'turn_checkpoint'
  | 'run_configured'
  | 'model_error'
  | 'summary'
  | 'skill_loaded'
  | 'model_switched'
  | 'workspace_changed'
  | 'plan_mode'
  | 'plan_updated'
  | 'plan_approved'
  | 'plan_progress'
  | 'subagent_started'
  | 'subagent_finished'
  | 'background_started'
  | 'background_finished'
  | 'hook_finished'
  | 'mcp_capabilities';
export interface SessionEvent {
  sessionId: string;
  seq: number;
  type: EventType;
  at: string;
  payload: Record<string, unknown>;
}
export interface Session {
  id: string;
  workspace: string;
  managedWorkspace?: boolean;
  profile: ModelProfile;
  createdAt: string;
  updatedAt: string;
}
export interface ToolResult {
  output: string;
  isError: boolean;
  exitCode?: number;
  truncated?: boolean;
}
export interface ToolRequest {
  requestId: string;
  name: ToolName;
  input: Record<string, unknown>;
  workspace: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Unattended commands such as Hooks must not fall back to an unsandboxed host shell. */
  requireSandbox?: boolean;
}
export interface ToolResponse {
  requestId: string;
  result: ToolResult;
}
