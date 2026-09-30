import fs from 'node:fs';
import path from 'node:path';
import type { ToolCall } from './types.js';

export type Decision = 'allow' | 'ask' | 'deny';
/** Canonical-path validation is repeated by the executor immediately before access. */
export function decisionFor(
  call: ToolCall,
  workspace: string,
  managedPending = false,
): { decision: Decision; reason: string } {
  if (
    ![
      'read_file',
      'list_files',
      'search_repository',
      'list_snapshots',
      'restore_snapshot',
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
      'get_task',
      'update_task',
      'claim_task',
      'finish_task',
      'list_memory',
      'save_memory',
      'remember_preference',
    ].includes(call.name)
  )
    return { decision: 'deny', reason: '未知工具' };
  if (call.name === 'shell')
    return {
      decision: 'ask',
      reason: 'Shell 命令可执行任意程序；若系统缺少沙箱，批准后会直接在宿主机运行',
    };
  if (call.name === 'restore_snapshot')
    return {
      decision: 'ask',
      reason: '回滚会覆盖文件；撤销新建文件会删除它。若文件已有后续修改则拒绝回滚',
    };
  if (call.name === 'search_repository' || call.name === 'list_snapshots')
    return { decision: 'allow', reason: '读取工作区索引或快照记录' };
  if (call.name === 'create_task')
    return { decision: 'ask', reason: '创建任务会写入工作区 .tasks 目录' };
  if (call.name === 'update_task')
    return { decision: 'ask', reason: '修改任务会写入工作区 .tasks 目录' };
  if (call.name === 'mcp_list_tools' || call.name === 'mcp_call')
    return {
      decision: 'ask',
      reason: 'MCP 服务器可能作为本机进程运行；缺少沙箱时可访问运行账户有权限的资源',
    };
  if (
    [
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
      'list_tasks',
      'get_task',
      'claim_task',
      'finish_task',
      'list_memory',
      'remember_preference',
    ].includes(call.name)
  )
    return { decision: 'allow', reason: '读取状态或更新规划' };
  if (call.name === 'load_skill') return { decision: 'allow', reason: '读取已安装 Skill' };
  if (call.name === 'search') return { decision: 'allow', reason: '只读工作区搜索' };
  try {
    const root = managedPending ? path.resolve(workspace) : fs.realpathSync(workspace);
    const p = call.name === 'list_files' && call.input.path === undefined ? '.' : call.input.path;
    if (typeof p !== 'string' || !p) throw new Error('无效路径');
    const target = path.resolve(root, p);
    if (
      (target === root && call.name !== 'list_files') ||
      (target !== root && !target.startsWith(root + path.sep))
    )
      return { decision: 'deny', reason: '路径超出工作区' };
    let current = root;
    for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink())
          return { decision: 'deny', reason: '不允许符号链接路径' };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    if (call.name === 'list_files') {
      if (managedPending && target === root) return { decision: 'allow', reason: '只读目录浏览' };
      if (!fs.statSync(target).isDirectory()) throw new Error('只能浏览目录');
      return { decision: 'allow', reason: '只读目录浏览' };
    }
    if (call.name === 'write_file') {
      if (managedPending && path.dirname(target) === root)
        return { decision: 'ask', reason: '首次写入将创建默认项目文件夹和文件' };
      let ancestor = path.dirname(target);
      while (ancestor !== root && !fs.existsSync(ancestor)) {
        ancestor = path.dirname(ancestor);
      }
      if (fs.existsSync(ancestor) && !fs.statSync(ancestor).isDirectory()) {
        throw new Error('父目录不是目录');
      }
      if (fs.existsSync(target) && !fs.statSync(target).isFile()) {
        throw new Error('目标不是文件');
      }
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
