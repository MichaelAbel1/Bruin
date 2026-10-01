import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SessionEvent } from './types.js';
import { readWorkspaceFile } from './workspace-files.js';
import { listSnapshots, previewSnapshot } from './snapshots.js';

type Event = Pick<SessionEvent, 'type' | 'at' | 'payload'>;
export interface WorkspaceChange {
  path: string;
  source: 'agent' | 'workspace';
  status: 'added' | 'modified' | 'deleted';
}
function recordedWrites(events: Event[]) {
  const pending = new Map<string, Event[]>();
  const writes = new Map<string, { from: string; to: string }>();
  for (const event of events) {
    if (event.type === 'workspace_changed') {
      pending.clear();
      writes.clear();
      continue;
    }
    const id = String(event.payload.callId);
    if (event.type === 'tool_requested') {
      const queue = pending.get(id) ?? [];
      queue.push(event);
      pending.set(id, queue);
    } else if (['tool_finished', 'tool_denied', 'tool_unknown'].includes(event.type)) {
      const request = pending.get(id)?.shift();
      if (!request || event.type !== 'tool_finished' || event.payload.isError) continue;
      if (!['write_file', 'edit_file'].includes(String(request.payload.name))) continue;
      const input = request.payload.input as Record<string, unknown> | undefined;
      if (typeof input?.path === 'string' && !writes.has(input.path))
        writes.set(input.path, { from: request.at, to: event.at });
    }
  }
  return writes;
}
function git(workspace: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    maxBuffer: 2_000_000,
  });
}
export function listWorkspaceChanges(workspace: string, events: Event[]): WorkspaceChange[] {
  if (!fs.existsSync(workspace)) return [];
  const root = fs.realpathSync(workspace);
  const changes = new Map<string, WorkspaceChange>();
  const writes = recordedWrites(events);
  let snapshots: ReturnType<typeof listSnapshots> = [];
  if (writes.size) {
    try {
      snapshots = listSnapshots(workspace);
    } catch {
      /* Snapshot retention is optional. */
    }
  }
  for (const [relative, range] of writes) {
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) continue;
    const name = path.relative(root, target);
    const first = snapshots
      .filter((item) => item.path === name && item.at >= range.from && item.at <= range.to)
      .at(-1);
    changes.set(name, {
      path: name,
      source: 'agent',
      status: !fs.existsSync(target)
        ? 'deleted'
        : first?.action === 'delete_created_file'
          ? 'added'
          : 'modified',
    });
  }
  try {
    const prefix = git(root, ['rev-parse', '--show-prefix']).replace(/\r?\n$/, '');
    const entries = git(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ]).split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const state = entry.slice(0, 2);
      const name = entry.slice(3);
      if (/[RC]/.test(state)) {
        const previous = entries[++i];
        if (state.includes('R') && previous?.startsWith(prefix)) {
          const oldPath = previous.slice(prefix.length);
          changes.set(oldPath, { path: oldPath, source: 'workspace', status: 'deleted' });
        }
      }
      if (!name.startsWith(prefix)) continue;
      const relative = name.slice(prefix.length);
      if (
        !relative ||
        relative.split('/').includes('.bruin') ||
        relative.split('/').includes('node_modules')
      )
        continue;
      const status = state.includes('D')
        ? 'deleted'
        : state === '??' || /[ARC]/.test(state)
          ? 'added'
          : 'modified';
      changes.set(relative, {
        path: relative,
        source: changes.get(relative)?.source ?? 'workspace',
        status,
      });
    }
  } catch {
    /* Ordinary directories still show recorded file writes. */
  }
  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function readWorkspaceReview(workspace: string, relative: string, events: Event[]) {
  const change = listWorkspaceChanges(workspace, events).find((item) => item.path === relative);
  if (!change) throw new Error('文件不在当前变更列表中');
  let baseline: string | undefined;
  const writes = recordedWrites(events);
  const range = [...writes].find(
    ([file]) => path.resolve(workspace, file) === path.resolve(workspace, relative),
  )?.[1];
  if (range) {
    try {
      const snapshot = listSnapshots(workspace)
        .filter((item) => item.path === relative && item.at >= range.from && item.at <= range.to)
        .at(-1);
      if (snapshot) baseline = previewSnapshot(workspace, snapshot.id);
    } catch {
      /* Fall back to Git when snapshots were pruned or are unavailable. */
    }
  }
  if (change.status === 'deleted') {
    if (baseline === undefined) {
      try {
        baseline = git(workspace, ['show', `HEAD:./${relative.split(path.sep).join('/')}`]);
      } catch {
        baseline = '';
      }
    }
    if (Buffer.byteLength(baseline) > 256_000) throw new Error('删除文件超过预览上限');
    if (baseline.includes('\0')) throw new Error('二进制文件暂不支持预览');
    return {
      path: relative,
      content: '',
      baselineContent: baseline,
      truncated: false,
      readOnlyReason: '文件已删除，差异预览只读。',
    };
  }
  const file = readWorkspaceFile(workspace, relative);
  return {
    ...file,
    baselineContent:
      baseline ?? file.baselineContent ?? (change.status === 'added' ? '' : file.content),
  };
}
