import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { DB_PATH } from './config';

// --- Row type definitions ---

interface BlockRow {
  name: string;
  type: number;
  source: string;
  compression: number;
  data: Buffer;
  hash: string;
}

interface ChatRow {
  uuid: string;
  charId: string;
  chatIndex: number;
  data: Buffer;
  hash: string;
}

interface CharDetailRow {
  charId: string;
  data: Buffer;
  hash: string;
}

interface JobRow {
  id: string;
  char_id: string | null;
  status: string;
  response: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

// ---

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

    CREATE TABLE IF NOT EXISTS char_details (
      char_id     TEXT PRIMARY KEY,
      data        BLOB NOT NULL,
      hash        TEXT NOT NULL,
      updated_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS file_list_cache (
      path        TEXT PRIMARY KEY,
      last_used   INTEGER,
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

/**
 * Clear all cached data so hydration starts fresh.
 * Called on startup to avoid serving stale data from a previous run.
 */
export function resetDb(db: Database.Database): void {
  db.exec(`
    DELETE FROM blocks;
    DELETE FROM chats;
    DELETE FROM char_details;
    DELETE FROM jobs;
    DELETE FROM file_list_cache;
  `);
}

// --- Typed prepare helper ---
// better-sqlite3's prepare() accepts a Result generic.
// We use this instead of a statement cache to avoid `as` type assertions.

function prep<T>(db: Database.Database, sql: string) {
  return db.prepare<unknown[], T>(sql);
}

// --- Block CRUD ---

export function upsertBlock(
  db: Database.Database,
  name: string,
  type: number,
  source: string,
  compression: number,
  data: Buffer,
  hash: string,
): void {
  prep(db,
    `INSERT INTO blocks (name, type, source, compression, data, hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(name) DO UPDATE SET
       type=excluded.type, source=excluded.source,
       compression=excluded.compression, data=excluded.data,
       hash=excluded.hash, updated_at=unixepoch()`,
  ).run(name, type, source, compression, data, hash);
}

type BlockResult = Pick<BlockRow, 'type' | 'source' | 'compression' | 'data' | 'hash'>;
type BlocksBySourceResult = Pick<BlockRow, 'name' | 'type' | 'compression' | 'data' | 'hash'>;

export function getBlock(
  db: Database.Database,
  name: string,
): BlockResult | undefined {
  return prep<BlockResult>(db,
    'SELECT type, source, compression, data, hash FROM blocks WHERE name = ?',
  ).get(name);
}

export function getBlocksBySource(
  db: Database.Database,
  source: string,
): BlocksBySourceResult[] {
  return prep<BlocksBySourceResult>(db,
    'SELECT name, type, compression, data, hash FROM blocks WHERE source = ?',
  ).all(source);
}

export function getBlockHash(
  db: Database.Database,
  name: string,
): string | undefined {
  const row = prep<Pick<BlockRow, 'hash'>>(db,
    'SELECT hash FROM blocks WHERE name = ?',
  ).get(name);
  return row?.hash;
}

export function blockCount(db: Database.Database): number {
  const row = prep<{ cnt: number }>(db, 'SELECT COUNT(*) as cnt FROM blocks').get();
  return row?.cnt ?? 0;
}

// --- Batch query ---

interface RemoteBlockResult {
  name: string;
  data: Buffer;
}

export function getAllRemoteBlocks(
  db: Database.Database,
): RemoteBlockResult[] {
  return prep<RemoteBlockResult>(db,
    "SELECT name, data FROM blocks WHERE name LIKE 'remote:%'",
  ).all();
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
  prep(db,
    `INSERT INTO chats (uuid, char_id, chat_index, data, hash, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(uuid) DO UPDATE SET
       char_id=excluded.char_id, chat_index=excluded.chat_index,
       data=excluded.data, hash=excluded.hash, updated_at=unixepoch()`,
  ).run(uuid, charId, chatIndex, data, hash);
}

type ChatResult = Pick<ChatRow, 'charId' | 'chatIndex' | 'data' | 'hash'>;
type ChatsByCharResult = Pick<ChatRow, 'uuid' | 'chatIndex' | 'data' | 'hash'>;

export function getChat(
  db: Database.Database,
  uuid: string,
): ChatResult | undefined {
  return prep<ChatResult>(db,
    'SELECT char_id as charId, chat_index as chatIndex, data, hash FROM chats WHERE uuid = ?',
  ).get(uuid);
}

export function getChatsByCharId(
  db: Database.Database,
  charId: string,
): ChatsByCharResult[] {
  return prep<ChatsByCharResult>(db,
    'SELECT uuid, chat_index as chatIndex, data, hash FROM chats WHERE char_id = ? ORDER BY chat_index',
  ).all(charId);
}

export function deleteChatsByCharId(db: Database.Database, charId: string): void {
  prep(db, 'DELETE FROM chats WHERE char_id = ?').run(charId);
}

// --- CharDetail CRUD ---

export function upsertCharDetail(
  db: Database.Database,
  charId: string,
  data: Buffer,
  hash: string,
): void {
  prep(db,
    `INSERT INTO char_details (char_id, data, hash, updated_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(char_id) DO UPDATE SET
       data=excluded.data, hash=excluded.hash, updated_at=unixepoch()`,
  ).run(charId, data, hash);
}

type CharDetailResult = Pick<CharDetailRow, 'data' | 'hash'>;

export function getCharDetail(
  db: Database.Database,
  charId: string,
): CharDetailResult | undefined {
  return prep<CharDetailResult>(db,
    'SELECT data, hash FROM char_details WHERE char_id = ?',
  ).get(charId);
}

export function getAllCharDetails(
  db: Database.Database,
): CharDetailRow[] {
  return prep<CharDetailRow>(db,
    'SELECT char_id as charId, data, hash FROM char_details',
  ).all();
}

/**
 * Delete char_details (and associated chats/blocks) for characters
 * that no longer exist in the given active ID set.
 * Returns the list of purged char IDs.
 */
export function purgeStaleCharDetails(
  db: Database.Database,
  activeCharIds: Set<string>,
): string[] {
  const allRows = prep<Pick<CharDetailRow, 'charId'>>(db,
    'SELECT char_id as charId FROM char_details',
  ).all();

  const stale = allRows.filter((row) => !activeCharIds.has(row.charId));
  if (stale.length === 0) return [];

  for (const row of stale) {
    prep(db, 'DELETE FROM char_details WHERE char_id = ?').run(row.charId);
    prep(db, 'DELETE FROM chats WHERE char_id = ?').run(row.charId);
    prep(db, 'DELETE FROM blocks WHERE name = ?').run(`remote:${row.charId}`);
  }

  return stale.map((row) => row.charId);
}

/**
 * Check whether an asset path is referenced by any char_details entry.
 * Performs a text search on compressed detail blobs — caller must
 * decompress and pass the search function.
 */
export function getCharDetailBlobs(
  db: Database.Database,
): Array<{ charId: string; data: Buffer }> {
  return prep<{ charId: string; data: Buffer }>(db,
    'SELECT char_id as charId, data FROM char_details',
  ).all();
}

// --- File List Cache ---

export function populateFileListCache(
  db: Database.Database,
  paths: string[],
): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO file_list_cache (path, updated_at) VALUES (?, unixepoch())',
  );
  db.prepare('DELETE FROM file_list_cache').run();
  for (const p of paths) {
    insert.run(p);
  }
}

export function getFileListCache(
  db: Database.Database,
): string[] {
  return prep<{ path: string }>(db,
    'SELECT path FROM file_list_cache ORDER BY path',
  ).all().map((r) => r.path);
}

export function isFileListCacheReady(db: Database.Database): boolean {
  const row = prep<{ cnt: number }>(db,
    'SELECT COUNT(*) as cnt FROM file_list_cache',
  ).get();
  return (row?.cnt ?? 0) > 0;
}

export function addToFileListCache(db: Database.Database, path: string): void {
  prep(db,
    'INSERT OR IGNORE INTO file_list_cache (path, updated_at) VALUES (?, unixepoch())',
  ).run(path);
}

export function removeFromFileListCache(db: Database.Database, path: string): void {
  prep(db, 'DELETE FROM file_list_cache WHERE path = ?').run(path);
}

export function upsertMetaLastUsed(db: Database.Database, path: string, lastUsed: number): void {
  prep(db,
    `INSERT INTO file_list_cache (path, last_used, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(path) DO UPDATE SET last_used=excluded.last_used, updated_at=unixepoch()`,
  ).run(path, lastUsed);
}

export function getMetaEntries(
  db: Database.Database,
): Array<{ path: string; lastUsed: number }> {
  return prep<{ path: string; lastUsed: number }>(db,
    'SELECT path, last_used as lastUsed FROM file_list_cache WHERE last_used IS NOT NULL',
  ).all();
}

export function getMetaMissingLastUsed(
  db: Database.Database,
): string[] {
  return prep<{ path: string }>(db,
    "SELECT path FROM file_list_cache WHERE path LIKE 'remotes/%.meta' AND path NOT LIKE '%.meta.meta%' AND last_used IS NULL",
  ).all().map((r) => r.path);
}

// --- Job CRUD ---

export function createJob(
  db: Database.Database,
  id: string,
  charId: string | null,
): void {
  prep(db,
    `INSERT INTO jobs (id, char_id, status, response, created_at, updated_at)
     VALUES (?, ?, 'streaming', '', unixepoch(), unixepoch())`,
  ).run(id, charId);
}

export function appendJobResponse(
  db: Database.Database,
  id: string,
  text: string,
): void {
  prep(db,
    `UPDATE jobs SET response = ?, updated_at = unixepoch() WHERE id = ?`,
  ).run(text, id);
}

export function updateJobStatus(
  db: Database.Database,
  id: string,
  status: string,
  error?: string,
): void {
  prep(db,
    `UPDATE jobs SET status = ?, error = ?, updated_at = unixepoch() WHERE id = ?`,
  ).run(status, error ?? null, id);
}

export function getJob(
  db: Database.Database,
  id: string,
): JobRow | undefined {
  return prep<JobRow>(db,
    'SELECT id, char_id, status, response, error, created_at, updated_at FROM jobs WHERE id = ?',
  ).get(id);
}

export function getActiveJobs(
  db: Database.Database,
): JobRow[] {
  return prep<JobRow>(db,
    `SELECT id, char_id, status, response, error, created_at, updated_at
     FROM jobs WHERE status IN ('streaming', 'completed', 'failed')
     ORDER BY created_at DESC`,
  ).all();
}

export function deleteJob(db: Database.Database, id: string): void {
  prep(db, 'DELETE FROM jobs WHERE id = ?').run(id);
}

// --- Transaction helper ---

export function inTransaction<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn)();
}
