import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dataDir } from '../config.js';
import { listWorkspaceEntries } from './workspace-files.js';

type Entry = {
  path: string;
  hash: string;
  size: number;
  symbols: Array<{ name: string; line: number }>;
};
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function searchRepository(workspace: string, query: string, limit = 20) {
  const root = fs.realpathSync(workspace);
  const directory = path.join(dataDir(), 'repository-index');
  const cacheFile = path.join(directory, `${digest(root)}.json`);
  let previous: Entry[] = [];
  try {
    if (fs.statSync(cacheFile).size < 10_000_000) {
      const value = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(value)) previous = value;
    }
  } catch {
    /* Rebuild a missing or corrupt cache. */
  }
  const cached = new Map(previous.map((entry) => [entry.path, entry]));
  const paths: string[] = [];
  const deadline = Date.now() + 20_000;
  let visited = 0;
  let truncated = false;
  let gitIgnore = true;
  try {
    const files = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      {
        cwd: root,
        maxBuffer: 2_000_000,
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    paths.push(...files.split('\0').filter(Boolean).slice(0, 10_000));
    truncated = files.split('\0').filter(Boolean).length > 10_000;
  } catch {
    gitIgnore = false;
    const walk = (relative: string) => {
      if (++visited > 10_000 || Date.now() > deadline) {
        truncated = true;
        return;
      }
      for (let offset = 0; offset < 10_000; offset += 300) {
        const entries = listWorkspaceEntries(root, relative, offset, 300);
        for (const entry of entries) {
          if (['.git', 'node_modules', '.bruin'].includes(entry.name)) continue;
          if (paths.length >= 10_000) {
            truncated = true;
            return;
          }
          if (entry.kind === 'directory') walk(entry.path);
          else paths.push(entry.path);
        }
        if (entries.length < 300 || truncated) break;
      }
    };
    walk('');
  }
  const entries: Entry[] = [];
  let bytes = 0;
  for (const relative of [...new Set(paths)]) {
    if (Date.now() > deadline || bytes > 20_000_000) {
      truncated = true;
      break;
    }
    const file = path.resolve(root, relative);
    const privateRoot = path.resolve(dataDir());
    if (file === privateRoot || file.startsWith(privateRoot + path.sep)) continue;
    if (!file.startsWith(root + path.sep)) continue;
    try {
      let current = root;
      let symlink = false;
      for (const part of path.relative(root, file).split(path.sep)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) {
          symlink = true;
          break;
        }
      }
      if (symlink) continue;
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) continue;
        if (stat.size > 1_000_000) {
          entries.push({ path: relative, hash: '', size: stat.size, symbols: [] });
          continue;
        }
        const buffer = Buffer.alloc(1_000_001);
        let count = 0;
        while (count < buffer.length) {
          const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
          if (!read) break;
          count += read;
        }
        bytes += count;
        if (count > 1_000_000 || buffer.subarray(0, count).includes(0)) continue;
        const hash = digest(buffer.subarray(0, count));
        const old = cached.get(relative);
        if (
          old?.hash === hash &&
          old.path === relative &&
          old.size === count &&
          Array.isArray(old.symbols) &&
          old.symbols.every(
            (item) =>
              item && typeof item.name === 'string' && Number.isInteger(item.line) && item.line > 0,
          )
        ) {
          entries.push(old);
          continue;
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
        const symbols: Entry['symbols'] = [];
        for (const [index, line] of text.split('\n').entries()) {
          const match = line.match(
            /^\s*(?:(?:export|default|public|private|protected|static|async|pub)\s+)*(?:(?:class|interface|type|enum|function|def|fn|func|struct|trait|const|let|var)\s+)([\p{L}_$][\p{L}\p{N}_$]*)/u,
          );
          if (match && symbols.length < 500) symbols.push({ name: match[1], line: index + 1 });
        }
        entries.push({ path: relative, hash, size: count, symbols });
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* Unreadable or changing files are omitted. */
    }
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${cacheFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(entries), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, cacheFile);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = entries
    .map((entry) => {
      const symbols = entry.symbols.filter((symbol) =>
        terms.every((term) => symbol.name.toLocaleLowerCase().includes(term)),
      );
      const name = entry.path.toLocaleLowerCase();
      const score =
        terms.reduce((score, term) => score + (name.includes(term) ? 2 : 0), 0) +
        symbols.length * 3;
      return { path: entry.path, size: entry.size, symbols: symbols.slice(0, 20), score };
    })
    .filter((entry) => !terms.length || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    indexedFiles: entries.length,
    truncated,
    gitIgnore,
    results: results.slice(0, limit),
    hasMore: results.length > limit,
  };
}
