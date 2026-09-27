export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible';
export type ToolName = 'read_file' | 'write_file' | 'edit_file' | 'search' | 'shell' | 'load_skill';
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
  | 'model_switched';
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
