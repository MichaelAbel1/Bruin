export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible';
export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'search'
  | 'shell'
  | 'load_skill'
  | 'mcp_list_tools'
  | 'mcp_call'
  | 'spawn_subagent'
  | 'subagent_status'
  | 'create_worktree'
  | 'list_worktrees'
  | 'remove_worktree'
  | 'start_background'
  | 'background_status'
  | 'cancel_background'
  | 'update_plan'
  | 'update_plan_progress'
  | 'create_task'
  | 'list_tasks'
  | 'claim_task'
  | 'finish_task'
  | 'list_memory'
  | 'save_memory';
export interface ModelProfile {
  alias: string;
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
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
  | 'model_error'
  | 'summary'
  | 'skill_loaded'
  | 'model_switched'
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
}
export interface ToolResponse {
  requestId: string;
  result: ToolResult;
}
