import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import type { EventType, ModelProfile, Session, SessionEvent } from '../core/types.js';

export interface TaskNode {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  dependencies: string[];
  blocks: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown';
  owner?: string;
  expiresAt?: number;
  createdAt: string;
  updatedAt: string;
}
export interface TaskUpdate {
  title?: string;
  description?: string;
  addBlockedBy?: string[];
}
export interface CronJob {
  id: string;
  sessionId: string;
  expression: string;
  prompt: string;
  nextRunAt: number;
  lastStatus?: string;
}
export interface MemoryPage {
  key: string;
  content: string;
  updatedAt: string;
}
export interface UserPreference {
  id: string;
  content: string;
  createdAt: string;
}

/** Storage port: a PostgreSQL implementation must preserve append ordering and atomic append semantics. */
export interface EventStore {
  createSession(workspace: string, profile: ModelProfile): Session;
  getSession(id: string): Session | undefined;
  listSessions(): Session[];
  deleteSession(id: string): void;
  acquireLease(id: string, owner: string, ttlMs: number): void;
  renewLease(id: string, owner: string, ttlMs: number): boolean;
  releaseLease(id: string, owner: string): void;
  isLeased(id: string): boolean;
  scrubSecrets(secrets: string[]): number;
  createTask(
    sessionId: string,
    title: string,
    dependencies: string[],
    description?: string,
  ): TaskNode;
  getTask(sessionId: string, id: string): TaskNode | undefined;
  updateTask(sessionId: string, id: string, update: TaskUpdate): TaskNode;
  listTasks(sessionId: string): TaskNode[];
  syncTasks(sessionId: string): void;
  claimTask(sessionId: string, owner: string, ttlMs: number): TaskNode | undefined;
  renewTask(id: string, owner: string, ttlMs: number): boolean;
  finishTask(id: string, owner: string, success: boolean): void;
  releaseTask(id: string, owner: string): void;
  retryTask(sessionId: string, id: string): void;
  createCronJob(sessionId: string, expression: string, prompt: string): CronJob;
  listCronJobs(sessionId: string): CronJob[];
  deleteCronJob(sessionId: string, id: string): void;
  takeDueCronJobs(now: number): CronJob[];
  markCronJob(id: string, status: string): void;
  listMemory(workspace: string): MemoryPage[];
  saveMemory(workspace: string, key: string, content: string): void;
  listPreferences(): UserPreference[];
  savePreference(sessionId: string, content: string): UserPreference;
  deletePreference(id: string): void;
  setProfile(id: string, profile: ModelProfile, leaseOwner?: string): void;
  events(id: string): SessionEvent[];
  append(id: string, type: EventType, payload: Record<string, unknown>): SessionEvent;
  close(): void;
}
export class SqliteEventStore implements EventStore {
  private db: Database.Database;
  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    fs.chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('secure_delete = ON');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const schemaVersion = this.db.pragma('user_version', { simple: true }) as number;
    if (schemaVersion > 7) throw new Error(`数据库版本 ${schemaVersion} 高于当前支持的版本`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, profile_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL,
      type TEXT NOT NULL, at TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS events_type_idx ON events(session_id, type);
    CREATE TABLE IF NOT EXISTS session_leases (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_nodes (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title TEXT NOT NULL, dependencies_json TEXT NOT NULL, status TEXT NOT NULL,
      owner TEXT, expires_at INTEGER, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_tasks (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, origin_session_id TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', dependencies_json TEXT NOT NULL,
      status TEXT NOT NULL, owner TEXT, expires_at INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workspace_tasks_workspace_idx ON workspace_tasks(workspace, created_at, id);
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      expression TEXT NOT NULL, prompt TEXT NOT NULL, next_run_at INTEGER NOT NULL,
      last_status TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_pages (
      workspace TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace, key)
    );
    CREATE TABLE IF NOT EXISTS user_preferences (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, source_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
    if (schemaVersion < 6)
      this.db.transaction(() => {
        this.db.exec(`INSERT OR IGNORE INTO workspace_tasks
        (id, workspace, origin_session_id, title, description, dependencies_json, status, owner, expires_at, created_at, updated_at)
        SELECT t.id, s.workspace, t.session_id, t.title, '', t.dependencies_json,
          t.status, t.owner, t.expires_at, t.created_at, t.created_at
        FROM task_nodes t JOIN sessions s ON s.id = t.session_id`);
        this.db.pragma('user_version = 6');
      })();
    if (schemaVersion < 7) this.db.pragma('user_version = 7');
  }
  createSession(workspace: string, profile: ModelProfile): Session {
    const now = new Date().toISOString();
    const session = { id: randomUUID(), workspace, profile, createdAt: now, updatedAt: now };
    this.db
      .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
      .run(session.id, workspace, JSON.stringify(profile), now, now);
    return session;
  }
  private rowToSession(row: any): Session {
    return {
      id: row.id,
      workspace: row.workspace,
      profile: JSON.parse(row.profile_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? this.rowToSession(row) : undefined;
  }
  setProfile(id: string, profile: ModelProfile, leaseOwner?: string): void {
    this.db.transaction(() => {
      if (!this.getSession(id)) throw new Error(`会话不存在: ${id}`);
      const lease = this.db
        .prepare('SELECT owner FROM session_leases WHERE session_id = ? AND expires_at >= ?')
        .get(id, Date.now()) as { owner: string } | undefined;
      if (lease && lease.owner !== leaseOwner) throw new Error('此会话正在另一个进程中运行');
      this.db
        .prepare('UPDATE sessions SET profile_json = ? WHERE id = ?')
        .run(JSON.stringify(profile), id);
      this.append(id, 'model_switched', { profile });
    })();
  }
  listSessions(): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
      .all()
      .map((x) => this.rowToSession(x));
  }
  deleteSession(id: string): void {
    this.db.transaction(() => {
      if (!this.getSession(id)) throw new Error(`会话不存在: ${id}`);
      if (this.isLeased(id)) throw new Error('运行中的会话不能删除');
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM task_nodes WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM cron_jobs WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    })();
  }
  acquireLease(id: string, owner: string, ttlMs: number): void {
    if (!this.getSession(id)) throw new Error(`会话不存在: ${id}`);
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO session_leases (session_id, owner, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE session_leases.expires_at < ? OR session_leases.owner = ?`,
      )
      .run(id, owner, now + ttlMs, now, owner);
    if (!result.changes) throw new Error('此会话正在另一个进程中运行');
  }
  renewLease(id: string, owner: string, ttlMs: number): boolean {
    const now = Date.now();
    return (
      this.db
        .prepare(
          `UPDATE session_leases SET expires_at = ?
      WHERE session_id = ? AND owner = ? AND expires_at >= ?`,
        )
        .run(now + ttlMs, id, owner, now).changes === 1
    );
  }
  releaseLease(id: string, owner: string): void {
    this.db.prepare('DELETE FROM session_leases WHERE session_id = ? AND owner = ?').run(id, owner);
  }
  isLeased(id: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM session_leases WHERE session_id = ? AND expires_at >= ?')
        .get(id, Date.now()),
    );
  }
  private taskWorkspace(sessionId: string): string {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    return session.workspace;
  }
  private taskRows(workspace: string): TaskNode[] {
    const rows = this.db
      .prepare('SELECT * FROM workspace_tasks WHERE workspace = ? ORDER BY created_at, id')
      .all(workspace) as any[];
    const blocks = new Map<string, string[]>();
    for (const row of rows)
      for (const dependency of JSON.parse(row.dependencies_json) as string[])
        blocks.set(dependency, [...(blocks.get(dependency) ?? []), row.id]);
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.origin_session_id,
      title: row.title,
      description: row.description,
      dependencies: JSON.parse(row.dependencies_json),
      blocks: blocks.get(row.id) ?? [],
      status: row.status,
      ...(row.owner ? { owner: row.owner } : {}),
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  /** SQLite owns concurrency; .tasks is a repairable, human-readable workspace projection. */
  private ensureTaskDirectory(workspace: string): string {
    const directory = path.join(fs.realpathSync(workspace), '.tasks');
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory)
      throw new Error('.tasks 必须是工作区内的真实目录');
    return directory;
  }
  private syncTaskFiles(workspace: string): void {
    const tasks = this.taskRows(workspace);
    if (!tasks.length) return;
    const directory = this.ensureTaskDirectory(workspace);
    for (const task of tasks) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(task.id)) throw new Error('任务 ID 无法用作快照文件名');
      if (fs.realpathSync(directory) !== directory) throw new Error('.tasks 目录已被替换');
      const filename = path.join(directory, `${task.id}.json`);
      const content =
        JSON.stringify(
          {
            version: 1,
            id: task.id,
            subject: task.title,
            description: task.description,
            status: task.status,
            owner: task.owner ?? null,
            blockedBy: task.dependencies,
            blocks: task.blocks,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            originSessionId: task.sessionId,
          },
          null,
          2,
        ) + '\n';
      try {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('任务快照不能是符号链接');
        if (fs.readFileSync(filename, 'utf8') === content) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const temp = path.join(directory, `.${task.id}.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, filename);
      } finally {
        try {
          fs.unlinkSync(temp);
        } catch {
          /* Renamed or already removed. */
        }
      }
    }
  }
  private repairTaskFiles(workspace: string): void {
    try {
      this.syncTaskFiles(workspace);
    } catch (error) {
      process.stderr.write(
        `Bruin task snapshot sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  createTask(sessionId: string, title: string, dependencies: string[], description = ''): TaskNode {
    const workspace = this.taskWorkspace(sessionId);
    if (
      !title.trim() ||
      title.length > 500 ||
      description.length > 8000 ||
      dependencies.length > 30 ||
      new Set(dependencies).size !== dependencies.length
    )
      throw new Error('无效任务');
    this.ensureTaskDirectory(workspace);
    this.syncTaskFiles(workspace);
    const id = this.db.transaction(() => {
      const count = (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM workspace_tasks WHERE workspace = ?')
          .get(workspace) as { n: number }
      ).n;
      if (count >= 200) throw new Error('工作区任务已达到 200 项上限');
      for (const dependency of dependencies)
        if (
          !this.db
            .prepare('SELECT 1 FROM workspace_tasks WHERE id = ? AND workspace = ?')
            .get(dependency, workspace)
        )
          throw new Error('依赖任务不存在或不属于当前工作区');
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO workspace_tasks VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          workspace,
          sessionId,
          title.trim(),
          description.trim(),
          JSON.stringify(dependencies),
          now,
          now,
        );
      return id;
    })();
    this.repairTaskFiles(workspace);
    return this.taskRows(workspace).find((task) => task.id === id)!;
  }
  listTasks(sessionId: string): TaskNode[] {
    const workspace = this.taskWorkspace(sessionId);
    return this.taskRows(workspace);
  }
  syncTasks(sessionId: string): void {
    this.syncTaskFiles(this.taskWorkspace(sessionId));
  }
  getTask(sessionId: string, id: string): TaskNode | undefined {
    return this.listTasks(sessionId).find((task) => task.id === id);
  }
  updateTask(sessionId: string, id: string, update: TaskUpdate): TaskNode {
    const workspace = this.taskWorkspace(sessionId);
    this.syncTaskFiles(workspace);
    this.db.transaction(() => {
      const tasks = this.taskRows(workspace);
      const current = tasks.find((task) => task.id === id);
      if (!current) throw new Error('任务不存在或不属于当前工作区');
      if (
        update.title === undefined &&
        update.description === undefined &&
        update.addBlockedBy === undefined
      )
        throw new Error('没有任务修改内容');
      const title = update.title ?? current.title;
      const description = update.description ?? current.description;
      if (!title.trim() || title.length > 500 || description.length > 8000)
        throw new Error('无效任务内容');
      const additions = update.addBlockedBy ?? [];
      if (!Array.isArray(additions) || additions.some((dep) => typeof dep !== 'string'))
        throw new Error('无效依赖任务');
      const dependencies = [...new Set([...current.dependencies, ...additions])];
      if (dependencies.length > 30) throw new Error('任务依赖已达到 30 项上限');
      if (additions.length && current.status !== 'pending')
        throw new Error('只能修改待执行任务的依赖');
      const byId = new Map(tasks.map((task) => [task.id, task]));
      for (const dependency of dependencies) {
        if (!byId.has(dependency)) throw new Error('依赖任务不存在或不属于当前工作区');
        const visited = new Set<string>();
        const stack = [dependency];
        while (stack.length) {
          const node = stack.pop()!;
          if (node === id) throw new Error('任务依赖会形成环');
          if (visited.has(node)) continue;
          visited.add(node);
          stack.push(...(byId.get(node)?.dependencies ?? []));
        }
      }
      this.db
        .prepare(
          `UPDATE workspace_tasks SET title = ?, description = ?, dependencies_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          title.trim(),
          description.trim(),
          JSON.stringify(dependencies),
          new Date().toISOString(),
          id,
        );
    })();
    this.repairTaskFiles(workspace);
    return this.taskRows(workspace).find((task) => task.id === id)!;
  }
  claimTask(sessionId: string, owner: string, ttlMs: number): TaskNode | undefined {
    if (!owner || ttlMs < 1000 || ttlMs > 3600000) throw new Error('无效任务租约');
    const workspace = this.taskWorkspace(sessionId);
    const id = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE workspace_tasks SET status = 'unknown', owner = NULL, expires_at = NULL, updated_at = ?
        WHERE workspace = ? AND status = 'running' AND expires_at < ?`,
        )
        .run(new Date().toISOString(), workspace, Date.now());
      const tasks = this.taskRows(workspace);
      const held = tasks.find((task) => task.status === 'running' && task.owner === owner);
      if (held) return undefined;
      const completed = new Set(
        tasks.filter((task) => task.status === 'completed').map((task) => task.id),
      );
      const candidate = tasks.find(
        (task) => task.status === 'pending' && task.dependencies.every((dep) => completed.has(dep)),
      );
      if (!candidate) return undefined;
      this.db
        .prepare(
          `UPDATE workspace_tasks SET status = 'running', owner = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(owner, Date.now() + ttlMs, new Date().toISOString(), candidate.id);
      return candidate.id;
    })();
    this.repairTaskFiles(workspace);
    return id ? this.taskRows(workspace).find((task) => task.id === id) : undefined;
  }
  renewTask(id: string, owner: string, ttlMs: number): boolean {
    if (ttlMs < 1000 || ttlMs > 3600000) throw new Error('无效任务租约');
    return (
      this.db
        .prepare(
          `UPDATE workspace_tasks SET expires_at = ?
      WHERE id = ? AND owner = ? AND status = 'running' AND expires_at >= ?`,
        )
        .run(Date.now() + ttlMs, id, owner, Date.now()).changes === 1
    );
  }
  finishTask(id: string, owner: string, success: boolean): void {
    const row = this.db.prepare('SELECT workspace FROM workspace_tasks WHERE id = ?').get(id) as
      { workspace: string } | undefined;
    const result = this.db
      .prepare(
        `UPDATE workspace_tasks SET status = ?, owner = NULL, expires_at = NULL, updated_at = ?
      WHERE id = ? AND owner = ? AND status = 'running' AND expires_at >= ?`,
      )
      .run(success ? 'completed' : 'failed', new Date().toISOString(), id, owner, Date.now());
    if (!result.changes) throw new Error('任务租约已失效或不属于当前进程');
    if (row) this.repairTaskFiles(row.workspace);
  }
  releaseTask(id: string, owner: string): void {
    const row = this.db.prepare('SELECT workspace FROM workspace_tasks WHERE id = ?').get(id) as
      { workspace: string } | undefined;
    this.db
      .prepare(
        `UPDATE workspace_tasks SET status = 'pending', owner = NULL, expires_at = NULL, updated_at = ?
      WHERE id = ? AND owner = ? AND status = 'running'`,
      )
      .run(new Date().toISOString(), id, owner);
    if (row) this.repairTaskFiles(row.workspace);
  }
  retryTask(sessionId: string, id: string): void {
    const workspace = this.taskWorkspace(sessionId);
    const result = this.db
      .prepare(
        `UPDATE workspace_tasks SET status = 'pending', owner = NULL, expires_at = NULL, updated_at = ?
      WHERE id = ? AND workspace = ? AND status IN ('failed', 'unknown')`,
      )
      .run(new Date().toISOString(), id, workspace);
    if (!result.changes) throw new Error('只有失败或结果未知的任务可以重试');
    this.repairTaskFiles(workspace);
  }
  private rowToCronJob(row: any): CronJob {
    return {
      id: row.id,
      sessionId: row.session_id,
      expression: row.expression,
      prompt: row.prompt,
      nextRunAt: row.next_run_at,
      ...(row.last_status ? { lastStatus: row.last_status } : {}),
    };
  }
  createCronJob(sessionId: string, expression: string, prompt: string): CronJob {
    if (!this.getSession(sessionId)) throw new Error('会话不存在');
    if (
      !prompt.trim() ||
      prompt.length > 4000 ||
      expression.length > 100 ||
      expression.trim().split(/\s+/).length !== 5
    )
      throw new Error('无效定时任务');
    const nextRunAt = CronExpressionParser.parse(expression, { currentDate: new Date() })
      .next()
      .getTime();
    const id = randomUUID();
    this.db.transaction(() => {
      const count = (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM cron_jobs WHERE session_id = ?')
          .get(sessionId) as { n: number }
      ).n;
      if (count >= 50) throw new Error('会话定时任务已达到 50 项上限');
      this.db
        .prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, NULL)')
        .run(id, sessionId, expression, prompt.trim(), nextRunAt);
    })();
    return this.rowToCronJob(this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id));
  }
  listCronJobs(sessionId: string): CronJob[] {
    return (
      this.db
        .prepare('SELECT * FROM cron_jobs WHERE session_id = ? ORDER BY next_run_at')
        .all(sessionId) as any[]
    ).map((row) => this.rowToCronJob(row));
  }
  deleteCronJob(sessionId: string, id: string): void {
    const result = this.db
      .prepare('DELETE FROM cron_jobs WHERE session_id = ? AND id = ?')
      .run(sessionId, id);
    if (!result.changes) throw new Error('定时任务不存在');
  }
  takeDueCronJobs(now: number): CronJob[] {
    return this.db.transaction(() => {
      const due = (
        this.db
          .prepare('SELECT * FROM cron_jobs WHERE next_run_at <= ? ORDER BY next_run_at LIMIT 1')
          .all(now) as any[]
      ).map((row) => this.rowToCronJob(row));
      for (const job of due) {
        const next = CronExpressionParser.parse(job.expression, { currentDate: new Date(now) })
          .next()
          .getTime();
        this.db
          .prepare(`UPDATE cron_jobs SET next_run_at = ?, last_status = 'dispatched' WHERE id = ?`)
          .run(next, job.id);
      }
      return due;
    })();
  }
  markCronJob(id: string, status: string): void {
    this.db.prepare('UPDATE cron_jobs SET last_status = ? WHERE id = ?').run(status, id);
  }
  listMemory(workspace: string): MemoryPage[] {
    return (
      this.db
        .prepare(
          'SELECT key, content, updated_at FROM memory_pages WHERE workspace = ? ORDER BY key LIMIT 50',
        )
        .all(workspace) as Array<{ key: string; content: string; updated_at: string }>
    ).map((row) => ({ key: row.key, content: row.content, updatedAt: row.updated_at }));
  }
  saveMemory(workspace: string, key: string, content: string): void {
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(key) || !content.trim() || content.length > 8000)
      throw new Error('记忆名称或内容无效');
    const count = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM memory_pages WHERE workspace = ?')
        .get(workspace) as { n: number }
    ).n;
    if (
      count >= 50 &&
      !this.db
        .prepare('SELECT 1 FROM memory_pages WHERE workspace = ? AND key = ?')
        .get(workspace, key)
    )
      throw new Error('工作区记忆已达到 50 项上限');
    this.db
      .prepare(
        `INSERT INTO memory_pages VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace, key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .run(workspace, key, content.trim(), new Date().toISOString());
  }
  listPreferences(): UserPreference[] {
    return (
      this.db
        .prepare('SELECT id, content, created_at FROM user_preferences ORDER BY created_at, id')
        .all() as Array<{ id: string; content: string; created_at: string }>
    ).map((row) => ({ id: row.id, content: row.content, createdAt: row.created_at }));
  }
  savePreference(sessionId: string, content: string): UserPreference {
    const value = content.trim();
    const lastUser = [...this.events(sessionId)].reverse().find((event) => event.type === 'user');
    if (
      !value ||
      value.length > 1000 ||
      !lastUser ||
      !String(lastUser.payload.text ?? '').includes(value) ||
      /(?:sk-|gsk_|AIza|xai-)[A-Za-z0-9_-]{16,}/i.test(value)
    )
      throw new Error('偏好必须是本轮用户明确表达的原文，且不能包含密钥');
    const id = createHash('sha256').update(value).digest('hex').slice(0, 32);
    this.db.transaction(() => {
      const count = (
        this.db.prepare('SELECT COUNT(*) AS n FROM user_preferences').get() as { n: number }
      ).n;
      if (count >= 50 && !this.db.prepare('SELECT 1 FROM user_preferences WHERE id = ?').get(id))
        throw new Error('用户偏好已达到 50 项上限');
      this.db
        .prepare('INSERT OR IGNORE INTO user_preferences VALUES (?, ?, ?, ?)')
        .run(id, value, sessionId, new Date().toISOString());
    })();
    return this.listPreferences().find((item) => item.id === id)!;
  }
  deletePreference(id: string): void {
    this.db.prepare('DELETE FROM user_preferences WHERE id = ?').run(id);
  }
  scrubSecrets(secrets: string[]): number {
    const values = [...new Set(secrets.filter((value) => value.length >= 12))];
    if (!values.length) return 0;
    const scrub = (item: unknown): unknown => {
      if (typeof item === 'string')
        return values.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), item);
      if (Array.isArray(item)) return item.map(scrub);
      if (item && typeof item === 'object')
        return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, scrub(value)]));
      return item;
    };
    const changed = this.db.transaction(() => {
      let changed = 0;
      for (const row of this.db.prepare('SELECT id, profile_json FROM sessions').all() as Array<{
        id: string;
        profile_json: string;
      }>) {
        const next = JSON.stringify(scrub(JSON.parse(row.profile_json)));
        if (next !== row.profile_json) {
          this.db.prepare('UPDATE sessions SET profile_json = ? WHERE id = ?').run(next, row.id);
          changed++;
        }
      }
      for (const row of this.db.prepare('SELECT rowid, payload_json FROM events').all() as Array<{
        rowid: number;
        payload_json: string;
      }>) {
        const next = JSON.stringify(scrub(JSON.parse(row.payload_json)));
        if (next !== row.payload_json) {
          this.db
            .prepare('UPDATE events SET payload_json = ? WHERE rowid = ?')
            .run(next, row.rowid);
          changed++;
        }
      }
      return changed;
    })();
    if (changed) {
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        this.db.exec('VACUUM');
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Another reader may prevent compaction; redaction is already committed.
      }
    }
    return changed;
  }
  events(id: string): SessionEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq')
      .all(id)
      .map((r: any) => ({
        sessionId: id,
        seq: r.seq,
        type: r.type,
        at: r.at,
        payload: JSON.parse(r.payload_json),
      }));
  }
  append(id: string, type: EventType, payload: Record<string, unknown>): SessionEvent {
    const run = this.db.transaction(() => {
      if (!this.getSession(id)) throw new Error(`会话不存在: ${id}`);
      const seq = (
        this.db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE session_id = ?')
          .get(id) as { n: number }
      ).n;
      const at = new Date().toISOString();
      this.db
        .prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)')
        .run(id, seq, type, at, JSON.stringify(payload));
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(at, id);
      return { sessionId: id, seq, type, at, payload };
    });
    return run();
  }
  close(): void {
    this.db.close();
  }
}
