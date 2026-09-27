import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EventType, ModelProfile, Session, SessionEvent } from '../core/types.js';

/** Storage port: a PostgreSQL implementation must preserve append ordering and atomic append semantics. */
export interface EventStore {
  createSession(workspace: string, profile: ModelProfile): Session;
  getSession(id: string): Session | undefined;
  listSessions(): Session[];
  setProfile(id: string, profile: ModelProfile): void;
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
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const schemaVersion = this.db.pragma('user_version', { simple: true }) as number;
    if (schemaVersion > 1) throw new Error(`数据库版本 ${schemaVersion} 高于当前支持的版本`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, profile_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL,
      type TEXT NOT NULL, at TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS events_type_idx ON events(session_id, type);`);
    this.db.pragma('user_version = 1');
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
  setProfile(id: string, profile: ModelProfile): void {
    this.db.transaction(() => {
      if (!this.getSession(id)) throw new Error(`会话不存在: ${id}`);
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
