import type { ModelProfile } from '../core/types.js';
import { resolveApiKey } from './gateway.js';

const defaultBaseUrls = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
} as const;

export async function discoverModels(profile: ModelProfile): Promise<string[]> {
  const base =
    profile.baseUrl ??
    (profile.provider === 'openai-compatible' ? '' : defaultBaseUrls[profile.provider]);
  if (!base) throw new Error('请先配置 Base URL');
  const endpoint = new URL(`${base.replace(/\/+$/, '')}/models`);
  if (!['http:', 'https:'].includes(endpoint.protocol))
    throw new Error('模型目录仅支持 HTTP 或 HTTPS');
  const key = resolveApiKey(profile);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (profile.provider === 'anthropic') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (profile.provider === 'google') {
    if (key) headers['x-goog-api-key'] = key;
  } else if (key) headers.Authorization = `Bearer ${key}`;

  const ids = new Set<string>();
  for (let page = 0; page < 10 && ids.size < 500; page++) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new Error('获取模型列表失败：网络错误、重定向或超时');
    }
    if (!response.ok) throw new Error(`获取模型列表失败：HTTP ${response.status}`);
    const body = response.body;
    if (!body) throw new Error('模型列表响应为空');
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error('模型列表响应超过 1 MB');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new Error('模型列表不是有效 JSON');
    }
    const entries = profile.provider === 'google' ? result.models : result.data;
    if (!Array.isArray(entries)) throw new Error('模型列表格式不受支持');
    for (const item of entries) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (profile.provider === 'google') {
        const methods = row.supportedGenerationMethods ?? row.supportedActions;
        if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
      }
      const raw = profile.provider === 'google' ? row.name : row.id;
      if (typeof raw !== 'string' || !raw || raw.length > 200) continue;
      const id = profile.provider === 'google' ? raw.replace(/^models\//, '') : raw;
      ids.add(id);
      if (ids.size >= 500) break;
    }
    if (
      profile.provider === 'google' &&
      typeof result.nextPageToken === 'string' &&
      result.nextPageToken
    ) {
      endpoint.searchParams.set('pageToken', result.nextPageToken);
    } else if (
      profile.provider === 'anthropic' &&
      result.has_more === true &&
      typeof result.last_id === 'string'
    ) {
      endpoint.searchParams.set('after_id', result.last_id);
    } else break;
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}
