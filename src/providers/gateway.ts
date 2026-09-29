import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { ModelProfile, ToolCall } from '../core/types.js';
import { getRuntimeApiKey } from '../config.js';

export interface ModelReply {
  text: string;
  calls: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
  providerMessages?: ModelMessage[];
}
export interface ModelGateway {
  complete(
    profile: ModelProfile,
    prompt: ModelMessage[],
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<ModelReply>;
}
export const toolSchemas = {
  read_file: {
    description: 'Read a UTF-8 file inside the workspace',
    inputSchema: z.object({ path: z.string() }),
  },
  write_file: {
    description: 'Create or replace a UTF-8 file inside the workspace',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  },
  edit_file: {
    description: 'Replace exactly one occurrence in a UTF-8 file',
    inputSchema: z.object({ path: z.string(), oldText: z.string(), newText: z.string() }),
  },
  search: {
    description: 'Search workspace text with ripgrep',
    inputSchema: z.object({ pattern: z.string(), glob: z.string().optional() }),
  },
  load_skill: {
    description: 'Load the instructions of an installed skill by name',
    inputSchema: z.object({ name: z.string() }),
  },
  shell: {
    description: 'Run a shell command in the workspace. Requires user approval.',
    inputSchema: z.object({ command: z.string() }),
  },
  mcp_list_tools: {
    description: 'List tools offered by a configured MCP server',
    inputSchema: z.object({ server: z.string() }),
  },
  mcp_call: {
    description: 'Call a configured MCP server tool. Requires user approval.',
    inputSchema: z.object({
      server: z.string(),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).default({}),
    }),
  },
  spawn_subagent: {
    description: 'Start a read-only subagent for a bounded research task',
    inputSchema: z.object({ prompt: z.string(), worktree: z.string().optional() }),
  },
  subagent_status: {
    description: 'Read a subagent result by ID',
    inputSchema: z.object({ id: z.string() }),
  },
  create_worktree: {
    description: 'Create an isolated Git worktree at HEAD',
    inputSchema: z.object({ name: z.string().optional() }),
  },
  list_worktrees: {
    description: 'List Git worktrees for this workspace',
    inputSchema: z.object({}),
  },
  remove_worktree: {
    description: 'Remove a clean Bruin-managed Git worktree. Requires approval.',
    inputSchema: z.object({ path: z.string() }),
  },
  start_background: {
    description: 'Start a sandboxed shell command in the background. Requires approval.',
    inputSchema: z.object({ command: z.string() }),
  },
  background_status: {
    description: 'Read a background command status and output',
    inputSchema: z.object({ id: z.string() }),
  },
  cancel_background: {
    description: 'Stop a background command',
    inputSchema: z.object({ id: z.string() }),
  },
  update_plan: {
    description:
      'Create or revise a step-by-step execution plan. A revised plan needs user approval before changes.',
    inputSchema: z.object({ steps: z.array(z.string().min(1)).min(1).max(30) }),
  },
  update_plan_progress: {
    description: 'Mark an approved plan step pending, in progress or completed',
    inputSchema: z.object({
      index: z.number().int().min(0),
      status: z.enum(['pending', 'in_progress', 'completed']),
    }),
  },
  create_task: {
    description:
      'Add a task to the workspace task graph. Dependencies must be existing task IDs in this workspace.',
    inputSchema: z.object({
      title: z.string().min(1).max(500),
      description: z.string().max(8000).default(''),
      dependencies: z.array(z.string()).max(30).default([]),
    }),
  },
  list_tasks: {
    description: 'List durable tasks and their dependencies for this workspace',
    inputSchema: z.object({}),
  },
  get_task: {
    description: 'Read full details, owner and dependencies of one workspace task',
    inputSchema: z.object({ id: z.string() }),
  },
  update_task: {
    description:
      'Edit a workspace task and add dependencies; cycles are rejected. Requires approval.',
    inputSchema: z.object({
      id: z.string(),
      title: z.string().min(1).max(500).optional(),
      description: z.string().max(8000).optional(),
      addBlockedBy: z.array(z.string()).max(30).optional(),
    }),
  },
  claim_task: {
    description: 'Atomically claim the next ready task for this local Bruin process',
    inputSchema: z.object({}),
  },
  finish_task: {
    description: 'Mark a task claimed by this process completed or failed',
    inputSchema: z.object({ id: z.string(), success: z.boolean() }),
  },
  list_memory: {
    description: 'Read persistent memory for this workspace',
    inputSchema: z.object({}),
  },
  save_memory: {
    description: 'Save a persistent memory page for this workspace. Requires user approval.',
    inputSchema: z.object({ key: z.string(), content: z.string() }),
  },
  remember_preference: {
    description:
      'Remember a lasting user preference only when explicitly stated in the latest user message. Pass the exact words, not an inference.',
    inputSchema: z.object({ content: z.string().min(1).max(1000) }),
  },
};
function isLocalUrl(urlString?: string): boolean {
  if (!urlString) return false;
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:') return false;
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1'
    );
  } catch {
    return false;
  }
}

export function resolveApiKey(profile: ModelProfile): string | undefined {
  const keyName =
    profile.apiKeyEnv ??
    (
      {
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        google: 'GOOGLE_GENERATIVE_AI_API_KEY',
        'openai-compatible': 'BRUIN_COMPATIBLE_API_KEY',
      } as const
    )[profile.provider];
  const key = getRuntimeApiKey(profile.alias) ?? process.env[keyName];
  const isLocalCompatible = profile.provider === 'openai-compatible' && isLocalUrl(profile.baseUrl);
  if (!key && !isLocalCompatible) throw new Error(`缺少 API Key 环境变量: ${keyName}`);
  return key;
}
export function modelProtocol(profile: ModelProfile): string {
  if (profile.provider === 'openai') {
    if (!profile.baseUrl || new URL(profile.baseUrl).origin === 'https://api.openai.com')
      return 'openai-responses';
    return 'openai-chat';
  }
  return profile.provider === 'openai-compatible' ? 'openai-chat' : profile.provider;
}
export function providerModel(profile: ModelProfile) {
  const key = resolveApiKey(profile);
  switch (profile.provider) {
    case 'openai':
      return modelProtocol(profile) === 'openai-responses'
        ? createOpenAI({ apiKey: key, baseURL: profile.baseUrl }).responses(profile.model)
        : createOpenAICompatible({
            name: profile.alias,
            baseURL: profile.baseUrl!,
            apiKey: key!,
          }).chatModel(profile.model);
    case 'anthropic':
      return createAnthropic({ apiKey: key, baseURL: profile.baseUrl })(profile.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: key, baseURL: profile.baseUrl })(profile.model);
    case 'openai-compatible': {
      if (!profile.baseUrl) throw new Error('OpenAI compatible 模型需要 baseUrl');
      return createOpenAICompatible({
        name: profile.alias,
        baseURL: profile.baseUrl,
        apiKey: key ?? 'local',
      }).chatModel(profile.model);
    }
  }
}
export class AiSdkGateway implements ModelGateway {
  constructor(private mode: 'basic' | 'full' | 'read-only' = 'basic') {}
  async complete(
    profile: ModelProfile,
    prompt: ModelMessage[],
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<ModelReply> {
    const result = streamText({
      model: providerModel(profile),
      messages: prompt,
      tools:
        this.mode === 'full'
          ? toolSchemas
          : this.mode === 'read-only'
            ? {
                read_file: toolSchemas.read_file,
                search: toolSchemas.search,
                load_skill: toolSchemas.load_skill,
              }
            : {
                read_file: toolSchemas.read_file,
                write_file: toolSchemas.write_file,
                edit_file: toolSchemas.edit_file,
                search: toolSchemas.search,
                load_skill: toolSchemas.load_skill,
                shell: toolSchemas.shell,
              },
      abortSignal: signal,
      maxRetries: 2,
    });
    let text = '';
    let hidden = false;
    let pending = '';
    const visibleText = (delta: string): string => {
      let visible = '';
      for (const char of delta) {
        if (!pending && char !== '<') {
          if (!hidden) visible += char;
          continue;
        }
        pending += char;
        const tag = hidden ? '</think>' : '<think>';
        if (tag.startsWith(pending.toLowerCase())) {
          if (pending.length === tag.length) {
            hidden = !hidden;
            pending = '';
          }
        } else {
          if (!hidden) visible += pending;
          pending = '';
        }
      }
      return visible;
    };
    const calls: ToolCall[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        const visible = visibleText(part.text);
        text += visible;
        if (visible) onText(visible);
      }
      if (part.type === 'tool-call')
        calls.push({
          id: part.toolCallId,
          name: part.toolName as ToolCall['name'],
          input: part.input as Record<string, unknown>,
        });
      if (part.type === 'error') throw part.error;
    }
    if (pending && !hidden) {
      text += pending;
      onText(pending);
    }
    const usage = await result.usage;
    const response = await result.response;
    return {
      text,
      calls,
      providerMessages: response.messages,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    };
  }
}
