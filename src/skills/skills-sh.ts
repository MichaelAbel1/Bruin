import { installSnapshot, type SkillInfo } from './registry.js';

export interface SkillsShEntry {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  url: string;
}
async function fetchApi(endpoint: string): Promise<any> {
  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!token)
    throw new Error(
      'skills.sh API 需要 VERCEL_OIDC_TOKEN；也可在 skills.sh 浏览后使用 bruin skill install-github 安装',
    );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`https://skills.sh/api/v1/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`skills.sh API 返回 ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
export async function searchSkillsSh(query: string): Promise<SkillsShEntry[]> {
  if (query.length < 2) throw new Error('搜索词至少 2 个字符');
  const data = await fetchApi(`skills/search?q=${encodeURIComponent(query)}&limit=20`);
  return Array.isArray(data.data) ? data.data : [];
}
export async function installSkillsSh(id: string): Promise<SkillInfo> {
  if (!/^[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(id)) throw new Error('需要 owner/repo/skill 格式的 ID');
  const data = await fetchApi(`skills/${id}`);
  if (!Array.isArray(data.files)) throw new Error('市场未提供此 Skill 的文件快照');
  return installSnapshot(data.files, `skills.sh:${id}`, String(data.hash ?? 'unknown'));
}
