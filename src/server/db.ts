import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { DB_PATH } from './config';
import { DDL, SCHEMA_VERSION } from './schema';

// ─── ID 생성 ────────────────────────────────────────────────────

/** 32자 hex UUID 생성. schema.ts의 DEFAULT와 동일한 방식. */
function generateId(db: Database.Database): string {
  const row = db.prepare("SELECT lower(hex(randomblob(16))) as id").get() as { id: string };
  return row.id;
}

export { generateId };

// ─── Row 타입 ───────────────────────────────────────────────────

export interface CharacterRow {
  __ws_id: string;
  __ws_hash: string | null;
  __ws_source_file: string | null;
  __ws_created_at: string | null;
  __ws_updated_at: string | null;
  __ws_deleted_at: string | null;
  char_id: string | null;
  type: string | null;
  name: string;
  [key: string]: unknown;
}

export interface ChatSessionRow {
  __ws_id: string;
  __ws_character_id: string | null;
  __ws_hash: string | null;
  __ws_source_file: string | null;
  __ws_created_at: string | null;
  __ws_updated_at: string | null;
  __ws_deleted_at: string | null;
  uuid: string | null;
  chat_index: number | null;
  [key: string]: unknown;
}

export interface ChatMessageRow {
  __ws_id: string;
  __ws_session_id: string | null;
  __ws_display_order: number | null;
  chat_id: string | null;
  role: string | null;
  data: string;
  saying: string | null;
  name: string | null;
  time: number | null;
  [key: string]: unknown;
}

export interface AssetRow {
  __ws_id: string;
  __ws_source_file: string | null;
  __ws_created_at: string | null;
  __ws_deleted_at: string | null;
  hash: string | null;
  data: Buffer | null;
  mime_type: string | null;
  size: number | null;
}

export interface CharacterAssetMapRow {
  __ws_id: string;
  __ws_character_id: string | null;
  __ws_asset_id: string | null;
  __ws_order: number | null;
  __ws_deleted_at: string | null;
  field: string | null;
  label: string | null;
  ext: string | null;
  cc_type: string | null;
}

export interface BlockRow {
  __ws_id: string;
  __ws_hash: string | null;
  __ws_created_at: string | null;
  __ws_updated_at: string | null;
  __ws_deleted_at: string | null;
  name: string | null;
  type: number | null;
  source: string | null;
  data: string | null;
}

export interface FileListCacheRow {
  __ws_id: string;
  path: string | null;
  last_used: number | null;
}

// ─── Typed prepare 헬퍼 ─────────────────────────────────────────

function prep<T>(db: Database.Database, sql: string) {
  return db.prepare<unknown[], T>(sql);
}

// ─── 초기화 ─────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function initDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(DDL);

  // 스키마 버전 기록
  const versionRow = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  if (!versionRow || versionRow.version < SCHEMA_VERSION) {
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }

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

// ─── Characters CRUD ────────────────────────────────────────────

/** RisuAI 캐릭터 JSON → characters 테이블 컬럼 매핑 */
const CHARACTER_COLUMN_MAP: Record<string, string> = {
  chaId: 'char_id',
  type: 'type',
  name: 'name',
  chatPage: 'chat_page',
  viewScreen: 'view_screen',
  tags: 'tags',
  creator: 'creator',
  creatorNotes: 'creator_notes',
  characterVersion: 'character_version',
  nickname: 'nickname',
  utilityBot: 'utility_bot',
  removedQuotes: 'removed_quotes',
  firstMsgIndex: 'first_msg_index',
  chatFolders: 'chat_folders',
  reloadKeys: 'reload_keys',
  additionalData: 'additional_data',
  license: 'license',
  private: 'private',
  realmId: 'realm_id',
  imported: 'imported',
  trashTime: 'trash_time',
  source: 'source',
  creation_date: 'creation_date',
  modification_date: 'modification_date',
  lastInteraction: 'last_interaction',
  modules: 'modules',
  firstMessage: 'first_message',
  desc: 'desc',
  notes: 'notes',
  personality: 'personality',
  scenario: 'scenario',
  systemPrompt: 'system_prompt',
  postHistoryInstructions: 'post_history_instructions',
  exampleMessage: 'example_message',
  alternateGreetings: 'alternate_greetings',
  depth_prompt: 'depth_prompt',
  bias: 'bias',
  replaceGlobalNote: 'replace_global_note',
  additionalText: 'additional_text',
  translatorNote: 'translator_note',
  globalLore: 'global_lore',
  loreSettings: 'lore_settings',
  loreExt: 'lore_ext',
  lorePlus: 'lore_plus',
  customscript: 'customscript',
  triggerscript: 'triggerscript',
  virtualscript: 'virtualscript',
  scriptstate: 'scriptstate',
  backgroundHTML: 'background_html',
  backgroundCSS: 'background_css',
  largePortrait: 'large_portrait',
  inlayViewScreen: 'inlay_view_screen',
  hideChatIcon: 'hide_chat_icon',
  sdData: 'sd_data',
  newGenData: 'new_gen_data',
  ttsMode: 'tts_mode',
  ttsSpeech: 'tts_speech',
  voicevoxConfig: 'voicevox_config',
  naittsConfig: 'naitts_config',
  gptSoVitsConfig: 'gpt_sovits_config',
  fishSpeechConfig: 'fish_speech_config',
  hfTTS: 'hf_tts',
  vits: 'vits',
  oaiVoice: 'oai_voice',
  ttsReadOnlyQuoted: 'tts_read_only_quoted',
  supaMemory: 'supa_memory',
  extentions: 'extentions',
  defaultVariables: 'default_variables',
  group_only_greetings: 'group_only_greetings',
  lowLevelAccess: 'low_level_access',
  doNotChangeSeperateModels: 'do_not_change_seperate_models',
  escapeOutput: 'escape_output',
  prebuiltAssetCommand: 'prebuilt_asset_command',
  prebuiltAssetStyle: 'prebuilt_asset_style',
  prebuiltAssetExclude: 'prebuilt_asset_exclude',
  // 그룹 전용
  characters: 'group_characters',
  characterTalks: 'group_character_talks',
  characterActive: 'group_character_active',
  autoMode: 'group_auto_mode',
  useCharacterLore: 'group_use_character_lore',
  suggestMessages: 'group_suggest_messages',
  orderByOrder: 'group_order_by_order',
  oneAtTime: 'group_one_at_time',
};

/** DB에 컬럼이 있는 RisuAI 필드인지 확인 */
const KNOWN_COLUMN_FIELDS = new Set(Object.keys(CHARACTER_COLUMN_MAP));

/** 별도 테이블로 빠지는 필드 (characters 테이블에 저장하지 않음) */
const EXCLUDED_FIELDS = new Set([
  'chats', 'image', 'emotionImages', 'additionalAssets', 'ccAssets',
  '__strippedFields',
]);

/** JSON으로 직렬화해야 하는 필드 (배열/객체 값) */
const JSON_FIELDS = new Set([
  'tags', 'chat_folders', 'additional_data', 'source', 'modules',
  'alternate_greetings', 'depth_prompt', 'bias', 'global_lore',
  'lore_settings', 'lore_ext', 'customscript', 'triggerscript',
  'scriptstate', 'sd_data', 'new_gen_data', 'voicevox_config',
  'naitts_config', 'gpt_sovits_config', 'fish_speech_config',
  'hf_tts', 'vits', 'extentions', 'group_only_greetings',
  'prebuilt_asset_exclude', 'group_characters', 'group_character_talks',
  'group_character_active', 'group_suggest_messages',
]);

/** boolean → INTEGER 변환이 필요한 필드 */
const BOOLEAN_FIELDS = new Set([
  'utility_bot', 'removed_quotes', 'private', 'imported',
  'lore_plus', 'large_portrait', 'inlay_view_screen', 'hide_chat_icon',
  'tts_read_only_quoted', 'supa_memory', 'low_level_access',
  'do_not_change_seperate_models', 'escape_output', 'prebuilt_asset_command',
  'group_auto_mode', 'group_use_character_lore', 'group_order_by_order',
  'group_one_at_time',
]);

/**
 * RisuAI 캐릭터 JSON 객체 → DB 컬럼 값 객체로 변환.
 * 매핑되지 않는 필드가 있으면 경고 목록에 포함.
 */
export function characterJsonToColumns(
  json: Record<string, unknown>,
): { columns: Record<string, unknown>; unknownFields: string[] } {
  const columns: Record<string, unknown> = {};
  const unknownFields: string[] = [];

  for (const [risuKey, value] of Object.entries(json)) {
    if (EXCLUDED_FIELDS.has(risuKey)) continue;

    const col = CHARACTER_COLUMN_MAP[risuKey];
    if (!col) {
      unknownFields.push(risuKey);
      continue;
    }

    if (value === undefined || value === null) {
      columns[col] = null;
    } else if (BOOLEAN_FIELDS.has(col)) {
      columns[col] = value ? 1 : 0;
    } else if (JSON_FIELDS.has(col)) {
      columns[col] = typeof value === 'string' ? value : JSON.stringify(value);
    } else if (typeof value === 'object') {
      columns[col] = JSON.stringify(value);
    } else {
      columns[col] = value;
    }
  }

  return { columns, unknownFields };
}

/**
 * DB 컬럼 값 → RisuAI JSON 객체로 복원.
 * characters 테이블의 row를 원본 캐릭터 JSON 형태로 재구성.
 */
export function characterColumnsToJson(row: Record<string, unknown>): Record<string, unknown> {
  const json: Record<string, unknown> = {};
  const reverseMap: Record<string, string> = {};
  for (const [risuKey, col] of Object.entries(CHARACTER_COLUMN_MAP)) {
    reverseMap[col] = risuKey;
  }

  for (const [col, value] of Object.entries(row)) {
    if (col.startsWith('__ws_')) continue;

    const risuKey = reverseMap[col];
    if (!risuKey) continue;
    if (value === null || value === undefined) continue;

    if (BOOLEAN_FIELDS.has(col)) {
      json[risuKey] = value === 1;
    } else if (JSON_FIELDS.has(col)) {
      try {
        json[risuKey] = typeof value === 'string' ? JSON.parse(value) : value;
      } catch {
        json[risuKey] = value;
      }
    } else {
      json[risuKey] = value;
    }
  }

  return json;
}

export function upsertCharacter(
  db: Database.Database,
  wsId: string,
  charId: string | null,
  hash: string,
  sourceFile: string | null,
  columns: Record<string, unknown>,
): void {
  const colNames = Object.keys(columns);
  const allCols = ['__ws_id', '__ws_hash', '__ws_source_file', '__ws_updated_at', 'char_id', ...colNames];
  const placeholders = allCols.map(() => '?').join(', ');
  const updates = allCols
    .filter((c) => c !== '__ws_id')
    .map((c) => `${c}=excluded.${c}`)
    .join(', ');

  const values = [
    wsId,
    hash,
    sourceFile,
    new Date().toISOString(),
    charId,
    ...colNames.map((c) => columns[c] ?? null),
  ];

  db.prepare(
    `INSERT INTO characters (${allCols.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT(__ws_id) DO UPDATE SET ${updates}`,
  ).run(...values);
}

export function getCharacterByCharId(
  db: Database.Database,
  charId: string,
): CharacterRow | undefined {
  return prep<CharacterRow>(db,
    'SELECT * FROM characters WHERE char_id = ? AND __ws_deleted_at IS NULL',
  ).get(charId);
}

export function getCharacterById(
  db: Database.Database,
  wsId: string,
): CharacterRow | undefined {
  return prep<CharacterRow>(db,
    'SELECT * FROM characters WHERE __ws_id = ? AND __ws_deleted_at IS NULL',
  ).get(wsId);
}

export function getAllCharacterIds(
  db: Database.Database,
): Array<{ __ws_id: string; char_id: string }> {
  return prep<{ __ws_id: string; char_id: string }>(db,
    'SELECT __ws_id, char_id FROM characters WHERE __ws_deleted_at IS NULL',
  ).all();
}

export function getCharacterHash(
  db: Database.Database,
  charId: string,
): string | undefined {
  const row = prep<{ __ws_hash: string }>(db,
    'SELECT __ws_hash FROM characters WHERE char_id = ? AND __ws_deleted_at IS NULL',
  ).get(charId);
  return row?.__ws_hash;
}

export function softDeleteCharacter(
  db: Database.Database,
  wsId: string,
): void {
  const now = new Date().toISOString();
  prep(db, 'UPDATE characters SET __ws_deleted_at = ? WHERE __ws_id = ?').run(now, wsId);
}

// ─── Chat Sessions CRUD ─────────────────────────────────────────

export function upsertChatSession(
  db: Database.Database,
  wsId: string,
  characterWsId: string,
  uuid: string | null,
  chatIndex: number,
  fields: Record<string, unknown>,
  hash: string | null,
  sourceFile: string | null,
): void {
  const fieldCols = Object.keys(fields);
  const allCols = [
    '__ws_id', '__ws_character_id', '__ws_hash', '__ws_source_file', '__ws_updated_at',
    'uuid', 'chat_index', ...fieldCols,
  ];
  const placeholders = allCols.map(() => '?').join(', ');
  const updates = allCols
    .filter((c) => c !== '__ws_id')
    .map((c) => `${c}=excluded.${c}`)
    .join(', ');

  const values = [
    wsId, characterWsId, hash, sourceFile, new Date().toISOString(),
    uuid, chatIndex, ...fieldCols.map((c) => fields[c] ?? null),
  ];

  db.prepare(
    `INSERT INTO chat_sessions (${allCols.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT(__ws_id) DO UPDATE SET ${updates}`,
  ).run(...values);
}

export function getChatSessionsByCharacter(
  db: Database.Database,
  characterWsId: string,
): ChatSessionRow[] {
  return prep<ChatSessionRow>(db,
    'SELECT * FROM chat_sessions WHERE __ws_character_id = ? AND __ws_deleted_at IS NULL ORDER BY chat_index',
  ).all(characterWsId);
}

export function getChatSessionByUuid(
  db: Database.Database,
  uuid: string,
): ChatSessionRow | undefined {
  return prep<ChatSessionRow>(db,
    'SELECT * FROM chat_sessions WHERE uuid = ? AND __ws_deleted_at IS NULL',
  ).get(uuid);
}

export function softDeleteChatSessionsByCharacter(
  db: Database.Database,
  characterWsId: string,
): void {
  const now = new Date().toISOString();
  prep(db,
    'UPDATE chat_sessions SET __ws_deleted_at = ? WHERE __ws_character_id = ? AND __ws_deleted_at IS NULL',
  ).run(now, characterWsId);
}

// ─── Chat Messages CRUD ─────────────────────────────────────────

export function insertChatMessages(
  db: Database.Database,
  sessionWsId: string,
  messages: Array<Record<string, unknown>>,
): void {
  const insert = db.prepare(`
    INSERT INTO chat_messages (
      __ws_id, __ws_session_id, __ws_display_order,
      chat_id, role, data, saying, name, time,
      disabled, is_comment, other_user, generation_info, prompt_info
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    insert.run(
      generateId(db),
      sessionWsId,
      i,
      msg.chatId ?? null,
      msg.role ?? null,
      msg.data ?? '',
      msg.saying ?? null,
      msg.name ?? null,
      msg.time ?? null,
      msg.disabled !== undefined ? String(msg.disabled) : null,
      msg.isComment ? 1 : null,
      msg.otherUser ? 1 : null,
      msg.generationInfo ? JSON.stringify(msg.generationInfo) : '{}',
      msg.promptInfo ? JSON.stringify(msg.promptInfo) : '{}',
    );
  }
}

export function getChatMessagesBySession(
  db: Database.Database,
  sessionWsId: string,
): ChatMessageRow[] {
  return prep<ChatMessageRow>(db,
    'SELECT * FROM chat_messages WHERE __ws_session_id = ? AND __ws_deleted_at IS NULL ORDER BY __ws_display_order',
  ).all(sessionWsId);
}

export function softDeleteChatMessagesBySession(
  db: Database.Database,
  sessionWsId: string,
): void {
  const now = new Date().toISOString();
  prep(db,
    'UPDATE chat_messages SET __ws_deleted_at = ? WHERE __ws_session_id = ? AND __ws_deleted_at IS NULL',
  ).run(now, sessionWsId);
}

// ─── Assets CRUD ────────────────────────────────────────────────

export function upsertAsset(
  db: Database.Database,
  wsId: string,
  hash: string,
  data: Buffer,
  mimeType: string | null,
  sourceFile: string | null,
): void {
  db.prepare(`
    INSERT INTO assets (__ws_id, hash, data, mime_type, size, __ws_source_file, __ws_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(__ws_id) DO UPDATE SET
      hash=excluded.hash, data=excluded.data, mime_type=excluded.mime_type,
      size=excluded.size, __ws_source_file=excluded.__ws_source_file,
      __ws_updated_at=excluded.__ws_updated_at
  `).run(wsId, hash, data, mimeType, data.length, sourceFile);
}

export function getAssetByHash(
  db: Database.Database,
  hash: string,
): AssetRow | undefined {
  return prep<AssetRow>(db,
    'SELECT * FROM assets WHERE hash = ? AND __ws_deleted_at IS NULL',
  ).get(hash);
}

export function getAssetById(
  db: Database.Database,
  wsId: string,
): AssetRow | undefined {
  return prep<AssetRow>(db,
    'SELECT * FROM assets WHERE __ws_id = ? AND __ws_deleted_at IS NULL',
  ).get(wsId);
}

/** 에셋이 아직 참조되고 있는지 (삭제 보호용) */
export function isAssetReferenced(
  db: Database.Database,
  assetWsId: string,
): boolean {
  const row = prep<{ cnt: number }>(db,
    'SELECT COUNT(*) as cnt FROM character_asset_map WHERE __ws_asset_id = ? AND __ws_deleted_at IS NULL',
  ).get(assetWsId);
  return (row?.cnt ?? 0) > 0;
}

/** hash로 에셋 참조 여부 확인 (remove-handler용) */
export function isAssetHashReferenced(
  db: Database.Database,
  hash: string,
): boolean {
  const row = prep<{ cnt: number }>(db, `
    SELECT COUNT(*) as cnt FROM character_asset_map cam
    JOIN assets a ON a.__ws_id = cam.__ws_asset_id
    WHERE a.hash = ? AND cam.__ws_deleted_at IS NULL AND a.__ws_deleted_at IS NULL
  `).get(hash);
  return (row?.cnt ?? 0) > 0;
}

export function softDeleteAsset(
  db: Database.Database,
  wsId: string,
): void {
  const now = new Date().toISOString();
  prep(db, 'UPDATE assets SET __ws_deleted_at = ? WHERE __ws_id = ?').run(now, wsId);
}

// ─── Character Asset Map CRUD ───────────────────────────────────

export function linkCharacterAsset(
  db: Database.Database,
  characterWsId: string,
  assetWsId: string,
  field: string,
  label: string | null,
  ext: string | null,
  ccType: string | null,
  order: number | null,
): void {
  db.prepare(`
    INSERT INTO character_asset_map (
      __ws_id, __ws_character_id, __ws_asset_id, __ws_order,
      field, label, ext, cc_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(generateId(db), characterWsId, assetWsId, order, field, label, ext, ccType);
}

export function getAssetMapByCharacter(
  db: Database.Database,
  characterWsId: string,
): CharacterAssetMapRow[] {
  return prep<CharacterAssetMapRow>(db,
    'SELECT * FROM character_asset_map WHERE __ws_character_id = ? AND __ws_deleted_at IS NULL ORDER BY field, __ws_order',
  ).all(characterWsId);
}

export function softDeleteAssetMapByCharacter(
  db: Database.Database,
  characterWsId: string,
): void {
  const now = new Date().toISOString();
  prep(db,
    'UPDATE character_asset_map SET __ws_deleted_at = ? WHERE __ws_character_id = ? AND __ws_deleted_at IS NULL',
  ).run(now, characterWsId);
}

// ─── Blocks CRUD ────────────────────────────────────────────────

export function upsertBlock(
  db: Database.Database,
  wsId: string,
  name: string,
  type: number,
  source: string,
  data: string,
  hash: string,
): void {
  db.prepare(`
    INSERT INTO blocks (__ws_id, name, type, source, data, __ws_hash, __ws_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(__ws_id) DO UPDATE SET
      name=excluded.name, type=excluded.type, source=excluded.source,
      data=excluded.data, __ws_hash=excluded.__ws_hash,
      __ws_updated_at=excluded.__ws_updated_at
  `).run(wsId, name, type, source, data, hash);
}

/** name으로 블록 조회 (기존 코드 호환) */
export function getBlockByName(
  db: Database.Database,
  name: string,
): BlockRow | undefined {
  return prep<BlockRow>(db,
    'SELECT * FROM blocks WHERE name = ? AND __ws_deleted_at IS NULL',
  ).get(name);
}

export function getBlocksBySource(
  db: Database.Database,
  source: string,
): BlockRow[] {
  return prep<BlockRow>(db,
    'SELECT * FROM blocks WHERE source = ? AND __ws_deleted_at IS NULL',
  ).all(source);
}

export function getBlockHash(
  db: Database.Database,
  name: string,
): string | undefined {
  const row = prep<{ __ws_hash: string }>(db,
    'SELECT __ws_hash FROM blocks WHERE name = ? AND __ws_deleted_at IS NULL',
  ).get(name);
  return row?.__ws_hash;
}

export function blockCount(db: Database.Database): number {
  const row = prep<{ cnt: number }>(db,
    'SELECT COUNT(*) as cnt FROM blocks WHERE __ws_deleted_at IS NULL',
  ).get();
  return row?.cnt ?? 0;
}

export function softDeleteBlock(
  db: Database.Database,
  name: string,
): void {
  const now = new Date().toISOString();
  prep(db, 'UPDATE blocks SET __ws_deleted_at = ? WHERE name = ?').run(now, name);
}

// ─── File List Cache CRUD ───────────────────────────────────────

export function populateFileListCache(
  db: Database.Database,
  paths: string[],
): void {
  const now = new Date().toISOString();
  // 기존 캐시 soft delete
  db.prepare("UPDATE file_list_cache SET __ws_deleted_at = ? WHERE __ws_deleted_at IS NULL").run(now);

  const insert = db.prepare(
    'INSERT INTO file_list_cache (__ws_id, path) VALUES (?, ?)',
  );
  for (const p of paths) {
    insert.run(generateId(db), p);
  }
}

export function getFileListCache(
  db: Database.Database,
): string[] {
  return prep<{ path: string }>(db,
    'SELECT path FROM file_list_cache WHERE __ws_deleted_at IS NULL ORDER BY path',
  ).all().map((r) => r.path);
}

export function isFileListCacheReady(db: Database.Database): boolean {
  const row = prep<{ cnt: number }>(db,
    'SELECT COUNT(*) as cnt FROM file_list_cache WHERE __ws_deleted_at IS NULL',
  ).get();
  return (row?.cnt ?? 0) > 0;
}

export function addToFileListCache(db: Database.Database, filePath: string): void {
  // 이미 있으면 무시
  const existing = prep<{ __ws_id: string }>(db,
    'SELECT __ws_id FROM file_list_cache WHERE path = ? AND __ws_deleted_at IS NULL',
  ).get(filePath);
  if (existing) return;

  db.prepare(
    'INSERT INTO file_list_cache (__ws_id, path) VALUES (?, ?)',
  ).run(generateId(db), filePath);
}

export function removeFromFileListCache(db: Database.Database, filePath: string): void {
  const now = new Date().toISOString();
  prep(db,
    'UPDATE file_list_cache SET __ws_deleted_at = ? WHERE path = ? AND __ws_deleted_at IS NULL',
  ).run(now, filePath);
}

export function upsertMetaLastUsed(db: Database.Database, filePath: string, lastUsed: number): void {
  const existing = prep<{ __ws_id: string }>(db,
    'SELECT __ws_id FROM file_list_cache WHERE path = ? AND __ws_deleted_at IS NULL',
  ).get(filePath);

  if (existing) {
    db.prepare(
      "UPDATE file_list_cache SET last_used = ?, __ws_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE __ws_id = ?",
    ).run(lastUsed, existing.__ws_id);
  } else {
    db.prepare(
      'INSERT INTO file_list_cache (__ws_id, path, last_used) VALUES (?, ?, ?)',
    ).run(generateId(db), filePath, lastUsed);
  }
}

export function getMetaEntries(
  db: Database.Database,
): Array<{ path: string; lastUsed: number }> {
  return prep<{ path: string; lastUsed: number }>(db,
    'SELECT path, last_used as lastUsed FROM file_list_cache WHERE last_used IS NOT NULL AND __ws_deleted_at IS NULL',
  ).all();
}

export function getMetaMissingLastUsed(
  db: Database.Database,
): string[] {
  return prep<{ path: string }>(db,
    "SELECT path FROM file_list_cache WHERE path LIKE 'remotes/%.meta' AND path NOT LIKE '%.meta.meta%' AND last_used IS NULL AND __ws_deleted_at IS NULL",
  ).all().map((r) => r.path);
}

// ─── Stale 데이터 정리 ──────────────────────────────────────────

/**
 * activeCharIds에 없는 캐릭터와 연관 데이터를 soft delete.
 * 기존 purgeStaleCharDetails → soft delete 버전.
 */
export function softDeleteStaleCharacters(
  db: Database.Database,
  activeCharIds: Set<string>,
): string[] {
  const allRows = prep<{ __ws_id: string; char_id: string }>(db,
    'SELECT __ws_id, char_id FROM characters WHERE __ws_deleted_at IS NULL',
  ).all();

  const stale = allRows.filter((row) => !activeCharIds.has(row.char_id));
  if (stale.length === 0) return [];

  const now = new Date().toISOString();
  for (const row of stale) {
    // 캐릭터 soft delete
    prep(db, 'UPDATE characters SET __ws_deleted_at = ? WHERE __ws_id = ?').run(now, row.__ws_id);
    // 연관 채팅 세션 soft delete
    prep(db, 'UPDATE chat_sessions SET __ws_deleted_at = ? WHERE __ws_character_id = ? AND __ws_deleted_at IS NULL').run(now, row.__ws_id);
    // 연관 채팅 메시지 soft delete
    prep(db, `
      UPDATE chat_messages SET __ws_deleted_at = ?
      WHERE __ws_session_id IN (SELECT __ws_id FROM chat_sessions WHERE __ws_character_id = ?)
      AND __ws_deleted_at IS NULL
    `).run(now, row.__ws_id);
    // 에셋 매핑 soft delete
    prep(db, 'UPDATE character_asset_map SET __ws_deleted_at = ? WHERE __ws_character_id = ? AND __ws_deleted_at IS NULL').run(now, row.__ws_id);
    // 블록 soft delete
    prep(db, 'UPDATE blocks SET __ws_deleted_at = ? WHERE name = ?').run(now, `remote:${row.char_id}`);
  }

  return stale.map((row) => row.char_id);
}

// ─── Transaction 헬퍼 ──────────────────────────────────────────

export function inTransaction<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn)();
}
