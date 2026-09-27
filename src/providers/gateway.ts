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
};
function apiKey(profile: ModelProfile): string | undefined {
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
  if (
    !key &&
    !(
      profile.provider === 'openai-compatible' && profile.baseUrl?.startsWith('http://localhost:')
    ) &&
    !(profile.provider === 'openai-compatible' && profile.baseUrl?.startsWith('http://127.0.0.1:'))
  )
    throw new Error(`缺少 API Key 环境变量: ${keyName}`);
  return key;
}
export function providerModel(profile: ModelProfile) {
  const key = apiKey(profile);
  switch (profile.provider) {
    case 'openai':
      return createOpenAI({ apiKey: key, baseURL: profile.baseUrl }).responses(profile.model);
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
  async complete(
    profile: ModelProfile,
    prompt: ModelMessage[],
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<ModelReply> {
    const result = streamText({
      model: providerModel(profile),
      messages: prompt,
      tools: toolSchemas,
      abortSignal: signal,
      maxRetries: 2,
    });
    let text = '';
    const calls: ToolCall[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
        onText(part.text);
      }
      if (part.type === 'tool-call')
        calls.push({
          id: part.toolCallId,
          name: part.toolName as ToolCall['name'],
          input: part.input as Record<string, unknown>,
        });
      if (part.type === 'error') throw part.error;
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
