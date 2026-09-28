import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dataDir } from '../config.js';

export interface AttachmentRef {
  id: string;
  name: string;
  kind: 'image' | 'document' | 'file';
  note?: string;
}
const maxFileBytes = 5_000_000;
const maxSelectionBytes = 20_000_000;
const maxFiles = 30;
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
function xmlText(value: string): string {
  return value
    .replace(/<\/w:p>|<\/row>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .slice(0, 60_000);
}
function zipEntry(file: string, entry: string): string {
  return execFileSync('unzip', ['-p', file, entry], {
    encoding: 'utf8',
    maxBuffer: 1_000_000,
    timeout: 5000,
  });
}
function extractText(file: string, name: string): { text: string; note?: string } {
  const ext = path.extname(name).toLowerCase();
  try {
    if (ext === '.docx') return { text: xmlText(zipEntry(file, 'word/document.xml')) };
    if (ext === '.xlsx') {
      let shared = '';
      try {
        shared = zipEntry(file, 'xl/sharedStrings.xml');
      } catch {
        /* Inline strings need no shared table. */
      }
      const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((item) => xmlText(item[1]));
      const sheet = zipEntry(file, 'xl/worksheets/sheet1.xml');
      const rows = [...sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
        [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
          .map((cell) => {
            const value = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
            if (/\bt="s"/.test(cell[1])) return strings[Number(value)] ?? '';
            if (/\bt="inlineStr"/.test(cell[1])) return xmlText(cell[2]);
            return xmlText(value);
          })
          .join('\t'),
      );
      return { text: rows.join('\n').slice(0, 60_000), note: '仅提取第一个工作表' };
    }
    if (ext === '.pdf')
      return {
        text: execFileSync('pdftotext', ['-layout', file, '-'], {
          encoding: 'utf8',
          maxBuffer: 1_000_000,
          timeout: 5000,
        }).slice(0, 60_000),
      };
    const bytes = fs.readFileSync(file);
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, 60_000) };
  } catch {
    return { text: '', note: '无法提取文本；该文件已保存在本机，但模型尚不能读取其内容' };
  }
}
function attachmentDir(sessionId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error('无效会话 ID');
  return path.join(dataDir(), 'attachments', sessionId);
}
function collect(files: string[], input: string): void {
  const stat = fs.lstatSync(input);
  if (stat.isSymbolicLink()) throw new Error('附件不允许符号链接');
  if (stat.isFile()) {
    files.push(input);
    return;
  }
  if (!stat.isDirectory()) throw new Error('仅支持普通文件和文件夹');
  for (const entry of fs.readdirSync(input)) {
    if (files.length >= maxFiles) throw new Error('一次最多上传 30 个文件');
    collect(files, path.join(input, entry));
  }
}
export function importAttachments(sessionId: string, selected: string[]): AttachmentRef[] {
  if (selected.length > maxFiles) throw new Error('一次最多上传 30 个文件');
  const files: string[] = [];
  for (const input of selected) collect(files, input);
  if (files.length > maxFiles) throw new Error('一次最多上传 30 个文件');
  let total = 0;
  for (const file of files) {
    const size = fs.statSync(file).size;
    if (size > maxFileBytes) throw new Error(`附件超过 5 MB: ${path.basename(file)}`);
    total += size;
  }
  if (total > maxSelectionBytes) throw new Error('一次上传总量不能超过 20 MB');
  const root = attachmentDir(sessionId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  try {
    return files.map((file) => {
      const id = randomUUID();
      const name = path.basename(file);
      const ext = path.extname(name).toLowerCase();
      const kind = imageTypes[ext]
        ? 'image'
        : ['.docx', '.xlsx', '.pdf', '.doc', '.xls', '.csv', '.txt', '.md'].includes(ext)
          ? 'document'
          : 'file';
      const target = path.join(root, id);
      const source = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(source);
        if (!stat.isFile() || stat.size > maxFileBytes)
          throw new Error(`附件不是普通文件或超过 5 MB: ${name}`);
        created.push(target);
        fs.writeFileSync(target, fs.readFileSync(source), { mode: 0o600, flag: 'wx' });
      } finally {
        fs.closeSync(source);
      }
      const extracted = kind === 'image' ? { text: '' } : extractText(target, name);
      const metadata = {
        id,
        name,
        kind,
        mimeType: imageTypes[ext] ?? 'application/octet-stream',
        ...extracted,
      };
      const metadataPath = path.join(root, `${id}.json`);
      created.push(metadataPath);
      fs.writeFileSync(metadataPath, JSON.stringify(metadata), {
        mode: 0o600,
        flag: 'wx',
      });
      return { id, name, kind, ...(extracted.note ? { note: extracted.note } : {}) };
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const file of created.reverse()) {
      try {
        fs.rmSync(file, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], '附件导入失败，部分文件清理失败');
    }
    throw error;
  }
}
export function loadAttachment(
  sessionId: string,
  id: string,
): { ref: AttachmentRef; text: string; image?: { data: Buffer; mimeType: string } } {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效附件 ID');
  const root = attachmentDir(sessionId);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(root, `${id}.json`), 'utf8'),
  ) as AttachmentRef & { text: string; mimeType: string };
  const ref: AttachmentRef = {
    id,
    name: metadata.name,
    kind: metadata.kind,
    ...(metadata.note ? { note: metadata.note } : {}),
  };
  return {
    ref,
    text: metadata.text,
    ...(metadata.kind === 'image'
      ? { image: { data: fs.readFileSync(path.join(root, id)), mimeType: metadata.mimeType } }
      : {}),
  };
}

export function deleteAttachments(sessionId: string): void {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error('无效会话 ID');
  const root = attachmentDir(sessionId);
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
