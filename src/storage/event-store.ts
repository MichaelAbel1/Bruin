import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import type { EventType, ModelProfile, Session, SessionEvent } from '../core/types.js';

export interface TaskNode {
  id: string;
  sessionId: string;
  title: string;
  dependencies: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown';
  owner?: string;
  expiresAt?: number;
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
  createTask(sessionId: string, title: string, dependencies: string[]): TaskNode;
  listTasks(sessionId: string): TaskNode[];
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
    if (schemaVersion > 5) throw new Error(`数据库版本 ${schemaVersion} 高于当前支持的版本`);
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
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      expression TEXT NOT NULL, prompt TEXT NOT NULL, next_run_at INTEGER NOT NULL,
      last_status TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_pages (
      workspace TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace, key)
    );`);
    this.db.pragma('user_version = 5');
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
  private rowToTask(row: any): TaskNode {
    return {
      id: row.id,
      sessionId: row.session_id,
      title: row.title,
      dependencies: JSON.parse(row.dependencies_json),
      status: row.status,
      ...(row.owner ? { owner: row.owner } : {}),
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    };
  }
  createTask(sessionId: string, title: string, dependencies: string[]): TaskNode {
    if (!this.getSession(sessionId)) throw new Error('会话不存在');
    if (
      !title.trim() ||
      title.length > 500 ||
      dependencies.length > 30 ||
      new Set(dependencies).size !== dependencies.length
    )
      throw new Error('无效任务');
    return this.db.transaction(() => {
      const count = (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM task_nodes WHERE session_id = ?')
          .get(sessionId) as { n: number }
      ).n;
      if (count >= 200) throw new Error('会话任务已达到 200 项上限');
      for (const id of dependencies) {
        const row = this.db
          .prepare('SELECT 1 FROM task_nodes WHERE id = ? AND session_id = ?')
          .get(id, sessionId);
        if (!row) throw new Error('依赖任务不存在或不属于当前会话');
      }
      const id = randomUUID();
      this.db
        .prepare(`INSERT INTO task_nodes VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?)`)
        .run(id, sessionId, title.trim(), JSON.stringify(dependencies), new Date().toISOString());
      return this.rowToTask(this.db.prepare('SELECT * FROM task_nodes WHERE id = ?').get(id));
    })();
  }
  listTasks(sessionId: string): TaskNode[] {
    return (
      this.db
        .prepare('SELECT * FROM task_nodes WHERE session_id = ? ORDER BY created_at, id')
        .all(sessionId) as any[]
    ).map((row) => this.rowToTask(row));
  }
  claimTask(sessionId: string, owner: string, ttlMs: number): TaskNode | undefined {
    if (!owner || ttlMs < 1000 || ttlMs > 3600000) throw new Error('无效任务租约');
    return this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE task_nodes SET status = 'unknown', owner = NULL, expires_at = NULL
        WHERE session_id = ? AND status = 'running' AND expires_at < ?`,
        )
        .run(sessionId, Date.now());
      const tasks = this.listTasks(sessionId);
      const completed = new Set(
        tasks.filter((task) => task.status === 'completed').map((task) => task.id),
      );
      const candidate = tasks.find(
        (task) => task.status === 'pending' && task.dependencies.every((id) => completed.has(id)),
      );
      if (!candidate) return undefined;
      this.db
        .prepare(`UPDATE task_nodes SET status = 'running', owner = ?, expires_at = ? WHERE id = ?`)
        .run(owner, Date.now() + ttlMs, candidate.id);
      return this.rowToTask(
        this.db.prepare('SELECT * FROM task_nodes WHERE id = ?').get(candidate.id),
      );
    })();
  }
  renewTask(id: string, owner: string, ttlMs: number): boolean {
    if (ttlMs < 1000 || ttlMs > 3600000) throw new Error('无效任务租约');
    return (
      this.db
        .prepare(
          `UPDATE task_nodes SET expires_at = ? WHERE id = ? AND owner = ? AND status = 'running' AND expires_at >= ?`,
        )
        .run(Date.now() + ttlMs, id, owner, Date.now()).changes === 1
    );
  }
  finishTask(id: string, owner: string, success: boolean): void {
    const result = this.db
      .prepare(
        `UPDATE task_nodes SET status = ?, owner = NULL, expires_at = NULL
      WHERE id = ? AND owner = ? AND status = 'running' AND expires_at >= ?`,
      )
      .run(success ? 'completed' : 'failed', id, owner, Date.now());
    if (!result.changes) throw new Error('任务租约已失效或不属于当前进程');
  }
  releaseTask(id: string, owner: string): void {
    this.db
      .prepare(
        `UPDATE task_nodes SET status = 'pending', owner = NULL, expires_at = NULL
      WHERE id = ? AND owner = ? AND status = 'running'`,
      )
      .run(id, owner);
  }
  retryTask(sessionId: string, id: string): void {
    const result = this.db
      .prepare(
        `UPDATE task_nodes SET status = 'pending', owner = NULL, expires_at = NULL
      WHERE id = ? AND session_id = ? AND status IN ('failed', 'unknown')`,
      )
      .run(id, sessionId);
    if (!result.changes) throw new Error('只有失败或结果未知的任务可以重试');
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
    this.db
      .prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, NULL)')
      .run(id, sessionId, expression, prompt.trim(), nextRunAt);
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
