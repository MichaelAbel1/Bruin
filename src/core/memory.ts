import type { MemoryPage } from '../storage/event-store.js';

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
  ].slice(0, 256);
}

/** Rank the existing bounded workspace pages without changing the storage contract. */
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
  for (const { page } of ranked) {
    const heading = `${JSON.stringify({ key: page.key, updatedAt: page.updatedAt })}\n`;
    const separator = selected.length ? '\n\n' : '';
    const available = remaining - heading.length - separator.length;
    if (available <= 0) continue;
    const truncated = page.content.length > available;
    const marker = '\n[truncated; use list_memory for the complete page]';
    if (truncated && available <= marker.length) continue;
    const content = truncated
      ? page.content.slice(0, available - marker.length) + marker
      : page.content;
    const entry = separator + heading + content;
    selected.push(entry);
    remaining -= entry.length;
    if (!remaining) break;
  }
  return selected.join('');
}
