import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionEvent, ToolResult } from './types.js';
import { listWorkspaceChanges } from './workspace-review.js';

const execGit = promisify(execFile);
const maxPatchBytes = 10_000_000;

async function workspaceRepository(workspace: string, signal: AbortSignal) {
  const { stdout } = await execGit(
    'git',
    ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-path', 'objects'],
    {
      cwd: workspace,
      signal,
      timeout: 5000,
      encoding: 'utf8',
    },
  );
  const [topLevel, sourceObjects, trailing] = stdout.split(/\r?\n/);
  if (!topLevel || !sourceObjects || trailing !== '' || !path.isAbsolute(sourceObjects))
    throw new Error('无法识别工作树的 Git 对象目录');
  return {
    root: fs.realpathSync.native(topLevel),
    sourceObjects: fs.realpathSync.native(sourceObjects),
  };
}

type GitRun = (
  args: string[],
  input?: string | Buffer,
  cwd?: string,
) => Promise<{ stdout: Buffer; stderr: Buffer }>;

async function withPatchRepository<T>(
  { sourceObjects }: Awaited<ReturnType<typeof workspaceRepository>>,
  baseCommit: string,
  signal: AbortSignal,
  use: (repository: { run: GitRun; gitDir: string; temporary: string }) => Promise<T>,
): Promise<T> {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bruin-patch-'));
  try {
    const gitDir = path.join(temporary, 'repository');
    const config = path.join(temporary, 'config');
    await fs.promises.writeFile(config, '', { mode: 0o600 });
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_PARAMETERS: undefined,
      GIT_CONFIG: undefined,
      GIT_ATTR_NOSYSTEM: '1',
      LC_ALL: 'C',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_DIR: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    };
    const run = (args: string[], input?: string | Buffer, cwd = temporary) => {
      const command = execGit('git', args, {
        cwd,
        env,
        signal,
        timeout: 10_000,
        maxBuffer: maxPatchBytes,
        encoding: 'buffer',
        windowsHide: true,
      });
      command.child.stdin?.on('error', () => {});
      command.child.stdin?.end(input);
      return command;
    };
    await run([
      'init',
      '-q',
      '--bare',
      '--template=',
      `--object-format=${baseCommit.length === 64 ? 'sha256' : 'sha1'}`,
      gitDir,
    ]);
    await fs.promises.writeFile(
      path.join(gitDir, 'objects', 'info', 'alternates'),
      sourceObjects + '\n',
    );
    return await use({ run, gitDir, temporary });
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

export type PatchPreflight = {
  baseCommit: string;
  status: 'compatible' | 'conflict' | 'cannot-apply';
  checked: string[];
  failedChildId?: string;
  conflictPaths: string[];
  detail?: string;
  test?: ToolResult;
};

export async function preflightWorkspacePatches(
  workspace: string,
  baseCommit: string,
  patches: Array<{ childId: string; workspace: string; content: Buffer }>,
  signal: AbortSignal,
  runTest?: (worktree: string) => Promise<ToolResult>,
): Promise<PatchPreflight> {
  const repository = await workspaceRepository(workspace, signal);
  for (const patch of patches) {
    const child = await workspaceRepository(patch.workspace, signal);
    if (child.sourceObjects !== repository.sourceObjects)
      throw new Error('所选子任务必须属于父会话当前的 Git 仓库');
  }
  return withPatchRepository(repository, baseCommit, signal, async ({ run, gitDir, temporary }) => {
    const worktree = path.join(temporary, 'worktree');
    await fs.promises.mkdir(worktree);
    const git = (args: string[], input?: Buffer) =>
      run(['--git-dir', gitDir, '--work-tree', worktree, ...args], input, worktree);
    await git(['read-tree', '--reset', '-u', baseCommit]);
    const checked: string[] = [];
    for (const patch of patches) {
      try {
        await git(['apply', '--index', '--3way', '--whitespace=nowarn', '-'], patch.content);
        checked.push(patch.childId);
      } catch (error) {
        signal.throwIfAborted();
        const failure = error as { code?: unknown; stderr?: Buffer };
        if (typeof failure.code !== 'number') throw error;
        const { stdout } = await git(['ls-files', '--unmerged', '-z']);
        const conflictPaths = new Set(
          stdout
            .toString('utf8')
            .split('\0')
            .filter(Boolean)
            .map((row) => row.slice(row.indexOf('\t') + 1)),
        );
        const diagnostic = String(failure.stderr ?? '').trim();
        if (!conflictPaths.size) {
          for (const line of diagnostic.split(/\r?\n/)) {
            const path =
              /^error: patch failed: (.+):\d+$/.exec(line)?.[1] ??
              /^error: (.+): (?:patch does not apply|already exists in (?:working directory|index)|does not exist in index|does not match index)$/.exec(
                line,
              )?.[1];
            if (path) conflictPaths.add(path);
          }
        }
        // File/directory collisions fail the worktree write before Git can stage conflicts.
        for (const diagnosticLine of diagnostic.split(/\r?\n/)) {
          const blocked =
            /^error: unable to write file '(.+)' mode [0-7]+: (?:Not a directory|Is a directory|Directory not empty)$/.exec(
              diagnosticLine,
            );
          if (blocked) conflictPaths.add(blocked[1]);
        }
        return {
          baseCommit,
          status: conflictPaths.size ? 'conflict' : 'cannot-apply',
          checked,
          failedChildId: patch.childId,
          conflictPaths: [...conflictPaths],
          detail: diagnostic.slice(0, 4000),
        };
      }
    }
    signal.throwIfAborted();
    const test = await runTest?.(worktree);
    signal.throwIfAborted();
    return {
      baseCommit,
      status: 'compatible',
      checked,
      conflictPaths: [],
      ...(test ? { test } : {}),
    };
  });
}

/** Stage into a disposable repository so Git cannot change either worktree's index or objects. */
export async function buildWorkspacePatch(
  workspace: string,
  events: SessionEvent[],
  baseCommit: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const workspaceRoot = fs.realpathSync.native(workspace);
  const changes = listWorkspaceChanges(workspace, events, baseCommit);
  if (!changes.length) throw new Error('此子任务没有可导出的工作树改动');
  const repository = await workspaceRepository(workspace, signal);
  const { root } = repository;
  const removed: string[] = [];
  const staged: string[] = [];
  for (const change of changes) {
    const target = path.resolve(workspaceRoot, change.path);
    if (!target.startsWith(workspaceRoot + path.sep) || !target.startsWith(root + path.sep))
      throw new Error('变更路径超出子任务工作区');
    const relative = path.relative(root, target).split(path.sep).join('/');
    if (change.status === 'deleted') {
      removed.push(relative);
      continue;
    }
    const parent = path.dirname(target);
    if (fs.realpathSync.native(parent) !== parent)
      throw new Error(`变更路径经过符号链接：${change.path}`);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error(`无法将目录或子模块导出为文件补丁：${change.path}`);
    staged.push(relative);
  }
  try {
    return await withPatchRepository(repository, baseCommit, signal, async ({ run, gitDir }) => {
      const stage = (args: string[], files?: string[]) =>
        run(
          ['--git-dir', gitDir, '--work-tree', root, ...args],
          files ? files.join('\0') + '\0' : undefined,
          root,
        );
      await stage(['read-tree', baseCommit]);
      if (removed.length) await stage(['update-index', '--force-remove', '-z', '--stdin'], removed);
      if (staged.length)
        await stage(['update-index', '--add', '--replace', '-z', '--stdin'], staged);
      const diff = ['diff', '--cached', '--no-renames', '--ignore-submodules=none'];
      const { stdout: raw } = await stage([...diff, '--raw', '-z', baseCommit, '--', '.']);
      const entries = raw.toString('utf8').split('\0');
      // A deleted or replaced submodule may no longer be a directory in the worktree.
      for (let index = 0; index + 1 < entries.length; index += 2) {
        const [before, after] = entries[index].slice(1).split(' ', 2);
        if (before === '160000' || after === '160000')
          throw new Error(`无法导出 Git 子模块变更：${entries[index + 1]}`);
      }
      const { stdout: patch } = await stage([
        ...diff,
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        baseCommit,
        '--',
        '.',
      ]);
      if (!patch.length) throw new Error('此子任务没有可导出的工作树改动');
      return patch;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      throw new Error('补丁超过 10 MB 导出上限');
    throw error;
  }
}
