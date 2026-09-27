import fs from 'node:fs';
import path from 'node:path';
import type { ToolCall } from './types.js';

export type Decision = 'allow' | 'ask' | 'deny';
/** Canonical-path validation is repeated by the executor immediately before access. */
export function decisionFor(
  call: ToolCall,
  workspace: string,
): { decision: Decision; reason: string } {
  if (
    ![
      'read_file',
      'write_file',
      'edit_file',
      'search',
      'shell',
      'load_skill',
      'mcp_list_tools',
      'mcp_call',
      'spawn_subagent',
      'subagent_status',
      'create_worktree',
      'list_worktrees',
      'remove_worktree',
      'start_background',
      'background_status',
      'cancel_background',
      'update_plan',
      'update_plan_progress',
      'create_task',
      'list_tasks',
      'claim_task',
      'finish_task',
      'list_memory',
      'save_memory',
    ].includes(call.name)
  )
    return { decision: 'deny', reason: '未知工具' };
  if (call.name === 'shell') return { decision: 'ask', reason: 'Shell 命令可执行任意程序' };
  if (
    [
      'mcp_call',
      'mcp_list_tools',
      'create_worktree',
      'remove_worktree',
      'start_background',
      'spawn_subagent',
      'save_memory',
    ].includes(call.name)
  )
    return { decision: 'ask', reason: '此操作可能启动进程、访问外部服务或更改工作区' };
  if (
    [
      'subagent_status',
      'list_worktrees',
      'background_status',
      'cancel_background',
      'update_plan',
      'update_plan_progress',
      'create_task',
      'list_tasks',
      'claim_task',
      'finish_task',
      'list_memory',
    ].includes(call.name)
  )
    return { decision: 'allow', reason: '读取状态或更新规划' };
  if (call.name === 'load_skill') return { decision: 'allow', reason: '读取已安装 Skill' };
  if (call.name === 'search') return { decision: 'allow', reason: '只读工作区搜索' };
  try {
    const root = fs.realpathSync(workspace);
    if (typeof call.input.path !== 'string' || !call.input.path) throw new Error('无效路径');
    const p = call.input.path;
    const target = path.resolve(root, p);
    if (target === root || !target.startsWith(root + path.sep))
      return { decision: 'deny', reason: '路径超出工作区' };
    let current = root;
    for (const segment of path.relative(root, target).split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink())
          return { decision: 'deny', reason: '不允许符号链接路径' };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    if (call.name === 'write_file') {
      if (!fs.statSync(path.dirname(target)).isDirectory()) throw new Error('父目录不是目录');
      return { decision: 'ask', reason: '创建或覆盖工作区文件' };
    }
    if (!fs.statSync(target).isFile()) throw new Error('目标不是文件');
    return call.name === 'edit_file'
      ? { decision: 'ask', reason: '修改工作区文件' }
      : { decision: 'allow', reason: '只读工作区文件' };
  } catch {
    return { decision: 'deny', reason: '文件不存在或无法验证路径' };
  }
}
