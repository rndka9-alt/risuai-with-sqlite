import type Database from 'better-sqlite3';

/**
 * Run schema migrations on an existing SQLite database.
 * Each migration checks preconditions before applying, so this is idempotent.
 */
export function dbMigrate(db: Database.Database): void {
  addFileListCacheLastUsed(db);
  addChatSessionsColdStatus(db);
  nullifyEmptyHypaV3(db);
}

/** chat_sessions: add __ws_cold_status column for cold storage retry tracking */
function addChatSessionsColdStatus(db: Database.Database): void {
  const columns = db.pragma('table_info(chat_sessions)') as Array<{ name: string }>;
  if (!columns.some((c) => c.name === '__ws_cold_status')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN __ws_cold_status TEXT');
  }
}

/** chat_sessions: '{}' → NULL. RisuAI는 truthy 체크로 초기화 여부를 판별하므로
 *  빈 객체는 "데이터 있음"으로 오인되어 toHypaV3Data({}) → .summaries.map() 크래시 유발. */
function nullifyEmptyHypaV3(db: Database.Database): void {
  db.exec("UPDATE chat_sessions SET hypa_v3 = NULL WHERE hypa_v3 = '{}'");
}

/** file_list_cache: add last_used column (added after initial schema) */
function addFileListCacheLastUsed(db: Database.Database): void {
  const columns = db.pragma('table_info(file_list_cache)') as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'last_used')) {
    db.exec('ALTER TABLE file_list_cache ADD COLUMN last_used INTEGER');
  }
}
