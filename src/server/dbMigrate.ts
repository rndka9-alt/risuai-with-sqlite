import type Database from 'better-sqlite3';

/**
 * Run schema migrations on an existing SQLite database.
 * Each migration checks preconditions before applying, so this is idempotent.
 */
export function dbMigrate(db: Database.Database): void {
  addFileListCacheLastUsed(db);
}

/** file_list_cache: add last_used column (added after initial schema) */
function addFileListCacheLastUsed(db: Database.Database): void {
  const columns = db.pragma('table_info(file_list_cache)') as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'last_used')) {
    db.exec('ALTER TABLE file_list_cache ADD COLUMN last_used INTEGER');
  }
}
