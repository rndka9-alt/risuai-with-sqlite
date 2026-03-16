import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { DB_PATH } from './config';

let _db: Database.Database | null = null;

export function initDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      name        TEXT PRIMARY KEY,
      type        INTEGER NOT NULL,
      source      TEXT NOT NULL,
      compression INTEGER NOT NULL DEFAULT 0,
      data        BLOB NOT NULL,
      hash        TEXT NOT NULL,
      updated_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS chats (
      uuid        TEXT PRIMARY KEY,
      char_id     TEXT NOT NULL,
      chat_index  INTEGER NOT NULL,
      data        BLOB NOT NULL,
      hash        TEXT NOT NULL,
      updated_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(type);
    CREATE INDEX IF NOT EXISTS idx_blocks_source ON blocks(source);
    CREATE INDEX IF NOT EXISTS idx_chats_char ON chats(char_id);

    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
      char_id     TEXT,
      status      TEXT NOT NULL DEFAULT 'streaming',
      response    TEXT NOT NULL DEFAULT '',
      error       TEXT,
      created_at  INTEGER DEFAULT (unixepoch()),
      updated_at  INTEGER DEFAULT (unixepoch())
    );
  `);

  _db = db;
  return db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialized');
  return _db;
}

export function isDbReady(): boolean {
  return _db !== null;
}

// --- Block CRUD ---

const _stmtCache = new Map<string, Database.Statement>();

function stmt(db: Database.Database, key: string, sql: string): Database.Statement {
  let s = _stmtCache.get(key);
  if (!s) {
    s = db.prepare(sql);
    _stmtCache.set(key, s);
  }
  return s;
}

export function upsertBlock(
  db: Database.Database,
  name: string,
  type: number,
  source: string,
  compression: number,
  data: Buffer,
  hash: string,
): void {
  stmt(
    db,
    'upsert_block',
    `INSERT INTO blocks (name, type, source, compression, data, hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(name) DO UPDATE SET
       type=excluded.type, source=excluded.source,
       compression=excluded.compression, data=excluded.data,
       hash=excluded.hash, updated_at=unixepoch()`,
  ).run(name, type, source, compression, data, hash);
}

export function getBlock(
  db: Database.Database,
  name: string,
): { type: number; source: string; compression: number; data: Buffer; hash: string } | undefined {
  return stmt(
    db,
    'get_block',
    'SELECT type, source, compression, data, hash FROM blocks WHERE name = ?',
  ).get(name) as any;
}

export function getBlocksBySource(
  db: Database.Database,
  source: string,
): Array<{ name: string; type: number; compression: number; data: Buffer; hash: string }> {
  return stmt(
    db,
    'get_blocks_by_source',
    'SELECT name, type, compression, data, hash FROM blocks WHERE source = ?',
  ).all(source) as any;
}

export function getBlockHash(
  db: Database.Database,
  name: string,
): string | undefined {
  const row = stmt(
    db,
    'get_block_hash',
    'SELECT hash FROM blocks WHERE name = ?',
  ).get(name) as { hash: string } | undefined;
  return row?.hash;
}

export function deleteBlock(db: Database.Database, name: string): void {
  stmt(db, 'delete_block', 'DELETE FROM blocks WHERE name = ?').run(name);
}

export function blockCount(db: Database.Database): number {
  const row = stmt(db, 'block_count', 'SELECT COUNT(*) as cnt FROM blocks').get() as { cnt: number };
  return row.cnt;
}

// --- Chat CRUD ---

export function upsertChat(
  db: Database.Database,
  uuid: string,
  charId: string,
  chatIndex: number,
  data: Buffer,
  hash: string,
): void {
  stmt(
    db,
    'upsert_chat',
    `INSERT INTO chats (uuid, char_id, chat_index, data, hash, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(uuid) DO UPDATE SET
       char_id=excluded.char_id, chat_index=excluded.chat_index,
       data=excluded.data, hash=excluded.hash, updated_at=unixepoch()`,
  ).run(uuid, charId, chatIndex, data, hash);
}

export function getChat(
  db: Database.Database,
  uuid: string,
): { charId: string; chatIndex: number; data: Buffer; hash: string } | undefined {
  const row = stmt(
    db,
    'get_chat',
    'SELECT char_id as charId, chat_index as chatIndex, data, hash FROM chats WHERE uuid = ?',
  ).get(uuid) as any;
  return row;
}

export function getChatsByCharId(
  db: Database.Database,
  charId: string,
): Array<{ uuid: string; chatIndex: number; data: Buffer; hash: string }> {
  return stmt(
    db,
    'get_chats_by_char',
    'SELECT uuid, chat_index as chatIndex, data, hash FROM chats WHERE char_id = ? ORDER BY chat_index',
  ).all(charId) as any;
}

export function deleteChatsByCharId(db: Database.Database, charId: string): void {
  stmt(db, 'delete_chats_by_char', 'DELETE FROM chats WHERE char_id = ?').run(charId);
}

// --- Job CRUD ---

export function createJob(
  db: Database.Database,
  id: string,
  charId: string | null,
): void {
  stmt(
    db,
    'create_job',
    `INSERT INTO jobs (id, char_id, status, response, created_at, updated_at)
     VALUES (?, ?, 'streaming', '', unixepoch(), unixepoch())`,
  ).run(id, charId);
}

export function appendJobResponse(
  db: Database.Database,
  id: string,
  text: string,
): void {
  stmt(
    db,
    'append_job_response',
    `UPDATE jobs SET response = ?, updated_at = unixepoch() WHERE id = ?`,
  ).run(text, id);
}

export function updateJobStatus(
  db: Database.Database,
  id: string,
  status: string,
  error?: string,
): void {
  stmt(
    db,
    'update_job_status',
    `UPDATE jobs SET status = ?, error = ?, updated_at = unixepoch() WHERE id = ?`,
  ).run(status, error ?? null, id);
}

export function getJob(
  db: Database.Database,
  id: string,
): { id: string; char_id: string | null; status: string; response: string; error: string | null; created_at: number; updated_at: number } | undefined {
  return stmt(
    db,
    'get_job',
    'SELECT id, char_id, status, response, error, created_at, updated_at FROM jobs WHERE id = ?',
  ).get(id) as ReturnType<typeof getJob>;
}

export function getActiveJobs(
  db: Database.Database,
): Array<{ id: string; char_id: string | null; status: string; response: string; error: string | null; created_at: number; updated_at: number }> {
  return stmt(
    db,
    'get_active_jobs',
    `SELECT id, char_id, status, response, error, created_at, updated_at
     FROM jobs WHERE status IN ('streaming', 'completed', 'failed')
     ORDER BY created_at DESC`,
  ).all() as ReturnType<typeof getActiveJobs>;
}

export function deleteJob(db: Database.Database, id: string): void {
  stmt(db, 'delete_job', 'DELETE FROM jobs WHERE id = ?').run(id);
}

// --- Transaction helper ---

export function inTransaction<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn)();
}
