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
function git(
  workspace: string,
  args: string[],
  options: { input?: string; strictText?: boolean } = {},
) {
  const output = execFileSync('git', args, {
    cwd: workspace,
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    timeout: 5000,
    maxBuffer: 2_000_000,
  });
  return options.strictText
    ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output)
    : output.toString('utf8');
}
function listChangesFromCommit(
  root: string,
  events: Event[],
  baseCommit: string,
): WorkspaceChange[] {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit))
    throw new Error('子任务缺少有效的启动提交，无法审核工作树');
  const tracked = git(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--relative',
    '--name-status',
    '-z',
    baseCommit,
    '--',
    '.',
  ]).split('\0');
  const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.']);
  const agentPaths = new Set(
    [...recordedWrites(events).keys()].map((file) => path.resolve(root, file)),
  );
  const changes = new Map<string, WorkspaceChange>();
  const add = (file: string, status: WorkspaceChange['status']) => {
    if (!file) return;
    const fromAgent = agentPaths.has(path.resolve(root, file));
    if (!fromAgent && file.split('/').some((part) => part === '.bruin' || part === 'node_modules'))
      return;
    changes.set(file, { path: file, status, source: fromAgent ? 'agent' : 'workspace' });
  };
  for (let i = 0; i + 1 < tracked.length; i += 2) {
    const [state, file] = [tracked[i], tracked[i + 1]];
    add(file, state === 'A' ? 'added' : state === 'D' ? 'deleted' : 'modified');
  }
  for (const file of untracked.split('\0')) add(file, changes.has(file) ? 'modified' : 'added');
  // Keep explicitly written files even when Git ignores them. Unrelated ignored
  // outputs stay out of the proposal, and tracked files restored to base stay out.
  const possibleIgnored = [...agentPaths]
    .filter((file) => file.startsWith(root + path.sep) && fs.existsSync(file))
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((file) => changes.get(file)?.status === 'deleted' || !changes.has(file));
  if (possibleIgnored.length) {
    try {
      const ignored = git(root, ['check-ignore', '-z', '--stdin'], {
        input: possibleIgnored.map((file) => `./${file}\0`).join(''),
      });
      for (const entry of ignored.split('\0')) {
        const file = entry.slice(2);
        add(file, changes.has(file) ? 'modified' : 'added');
      }
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error;
    }
  }
  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function listWorkspaceChanges(
  workspace: string,
  events: Event[],
  baseCommit?: string,
): WorkspaceChange[] {
  if (!fs.existsSync(workspace)) return [];
  const root = fs.realpathSync(workspace);
  if (baseCommit !== undefined) return listChangesFromCommit(root, events, baseCommit);
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
    const name = path.relative(root, target).split(path.sep).join('/');
    const first = snapshots
      .filter(
        (item) =>
          item.path.split(path.sep).join('/') === name &&
          item.at >= range.from &&
          item.at <= range.to,
      )
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
export function readWorkspaceReview(
  workspace: string,
  relative: string,
  events: Event[],
  baseCommit?: string,
) {
  const change = listWorkspaceChanges(workspace, events, baseCommit).find(
    (item) => item.path === relative,
  );
  if (!change) throw new Error('文件不在当前变更列表中');
  let baseline: string | undefined;
  if (baseCommit !== undefined) {
    baseline = '';
    if (change.status !== 'added') {
      try {
        baseline = git(workspace, ['cat-file', 'blob', `${baseCommit}:./${relative}`], {
          strictText: true,
        });
      } catch {
        throw new Error('无法读取启动提交中的文本版本');
      }
      if (Buffer.byteLength(baseline) > 256_000) throw new Error('基线文件超过预览上限');
      if (baseline.includes('\0')) throw new Error('二进制文件暂不支持预览');
    }
  } else {
    const range = [...recordedWrites(events)].find(
      ([file]) => path.resolve(workspace, file) === path.resolve(workspace, relative),
    )?.[1];
    if (range) {
      try {
        const normalizedRelative = relative.split(path.sep).join('/');
        const snapshot = listSnapshots(workspace)
          .filter(
            (item) =>
              item.path.split(path.sep).join('/') === normalizedRelative &&
              item.at >= range.from &&
              item.at <= range.to,
          )
          .at(-1);
        if (snapshot) baseline = previewSnapshot(workspace, snapshot.id);
      } catch {
        /* Fall back to Git when snapshots were pruned or are unavailable. */
      }
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
