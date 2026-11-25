import path from 'node:path';
import type { MemoryPage } from '../storage/event-store.js';
import { instructionTarget } from './instructions.js';
import type { SessionEvent } from './types.js';

const continuation =
  /^(?:请\s*)?(?:继续(?:吧|一下|执行|当前任务|上一个任务)?|接着(?:做|改|来)?|按(?:上面|之前|刚才)(?:的)?(?:改|做|继续))$|^(?:please\s+)?(?:continue|go on|resume)(?:\s+the (?:task|work|analysis))?$/iu;
const topicReset =
  /^(?:换(?:个|一个)(?:项目|话题|任务)|新任务|switch (?:topics?|projects?)|new task)$/iu;
const stopWords = new Set(
  'a an the to for of in on is it be do we my as at by or this that please check fix update review task project workspace src test tests ts js 检查 排查 修复 更新 查看 继续 项目 任务 工作 这个 当前'.split(
    ' ',
  ),
);

/** Follow short continuations within the current workspace, using durable user and tool events. */
export function workspaceMemoryQuery(workspace: string, events: readonly SessionEvent[]): string {
  const paths = new Set<string>();
  const results = new Map<string, boolean[]>();
  const pathHints = () => [...paths].join(' ');
  for (let index = events.length - 1; index >= 0; index--) {
    const { type, payload } = events[index];
    if (type === 'workspace_changed') break;
    if (type === 'user') {
      const text = String(payload.text ?? '').trim();
      const command = text
        .normalize('NFKC')
        .replace(/[.!?。！？]+$/u, '')
        .trim();
      if (topicReset.test(command)) return pathHints();
      const quote = payload.quote as { text?: string } | undefined;
      const quotedText = typeof quote?.text === 'string' ? quote.text.slice(0, 2000) : '';
      const attachments = Array.isArray(payload.attachments) && payload.attachments.length > 0;
      const task = continuation.test(command) ? '' : command;
      if (task || quotedText || attachments)
        return [task.slice(0, 6000), quotedText, pathHints()].filter(Boolean).join('\n');
    }
    if (paths.size >= 12 || typeof payload.callId !== 'string') continue;
    if (type === 'tool_finished' || type === 'tool_denied' || type === 'tool_unknown') {
      const queue = results.get(payload.callId) ?? [];
      queue.push(type === 'tool_finished' && payload.isError === false);
      results.set(payload.callId, queue);
    }
    if (type === 'tool_requested' && results.get(payload.callId)?.shift()) {
      const target = instructionTarget(payload.name, payload.input);
      if (!target) continue;
      const relative = path.relative(workspace, path.resolve(workspace, target.path));
      if (
        relative &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      )
        paths.add(relative.replace(/[\\/_.-]+/g, ' '));
    }
  }
  return pathHints();
}

function terms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words = normalized.match(/[a-z0-9_][a-z0-9_.-]*|[\p{Script=Han}]+/gu) ?? [];
  return [
    ...new Set(
      words.flatMap((word) =>
        /\p{Script=Han}/u.test(word) && word.length > 1
          ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))
          : [word],
      ),
    ),
  ]
    .filter((term) => !stopWords.has(term) && (term.length >= 2 || /\p{Script=Han}/u.test(term)))
    .slice(0, 256);
}

/** Rank matching notes, and give unmatched topics only an index entry. */
export function memoryContext(pages: MemoryPage[], query: string, maxChars = 8000): string {
  const keywords = terms(query);
  const ranked = pages
    .map((page, index) => {
      const key = page.key.normalize('NFKC').toLowerCase();
      const content = page.content.normalize('NFKC').toLowerCase();
      const score = keywords.reduce(
        (sum, term) => sum + (key.includes(term) ? 3 : 0) + (content.includes(term) ? 1 : 0),
        0,
      );
      return { page, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: string[] = [];
  let remaining = Math.max(0, Math.floor(maxChars));
  for (const { page, score } of ranked) {
    const heading = JSON.stringify({ key: page.key, updatedAt: page.updatedAt });
    const separator = selected.length ? '\n\n' : '';
    if (remaining < heading.length + separator.length) continue;
    const available = Math.min(2000, remaining - heading.length - separator.length - 1);
    const marker = '\n[truncated; use list_memory for the complete page]';
    let content = '';
    if (score > 0 && page.content.length <= available) content = '\n' + page.content;
    else if (score > 0 && available > marker.length) {
      let clipped = page.content.slice(0, available - marker.length);
      if (clipped.length > 0) {
        const lastCode = clipped.charCodeAt(clipped.length - 1);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff) clipped = clipped.slice(0, -1);
      }
      content = '\n' + clipped + marker;
    }
    const entry = separator + heading + content;
    selected.push(entry);
    remaining -= entry.length;
    if (!remaining) break;
  }
  return selected.join('');
}
