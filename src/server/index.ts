import crypto from 'crypto';
import http from 'http';
import { PORT, UPSTREAM, CLIENT_ID_HEADER, REQUEST_ID_HEADER, RISU_AUTH_HEADER, FILE_PATH_HEADER, AUTH_EXEMPT_ROUTES } from './config';
import { forwardRequest, forwardAndTee, forwardBufferAndTransform, decodeFilePath, fetchFromUpstream } from './proxy';
import { createCircuitBreaker } from './circuit-breaker';
import {
  initDb, isDbReady, getDb, generateId,
  getBlockByName, getBlocksBySource, upsertBlock,
  getCharacterByCharId, getAllCharacterIds, upsertCharacter,
  characterJsonToColumns, characterColumnsToJson,
  getChatSessionByUuid, getChatSessionsByCharacter,
  getChatMessagesBySession, upsertChatSession, insertChatMessages,
  softDeleteChatSessionsByCharacter, softDeleteChatMessagesBySession,
  upsertAsset, getAssetByHash, getAssetById, linkCharacterAsset, softDeleteAssetMapByCharacter,
  getAssetMapByCharacter,
  softDeleteStaleCharacters, inTransaction,
  populateFileListCache, getFileListCache, isFileListCacheReady,
  addToFileListCache, removeFromFileListCache,
  upsertMetaLastUsed, getMetaEntries, getMetaMissingLastUsed,
  blockCount,
} from './db';

import { parseRisuSave, parseRemoteFile, parseRemotePointer } from './parser';
import { assembleRisuSave } from './assembler';
import { HEAVY_FIELDS, COLD_STORAGE_HEADER, isColdMarker } from './slim';
import { compressColdStorage } from './cold-compat';
import { writeToUpstream } from './proxy';
import { handleWriteDatabase, handleWriteRemote } from './write-handler';
import { handleRemoveAsset, handleRemoveFile } from './remove-handler';
import { reconcileDatabaseBin, reconcileRemoteFile } from './reconcile';
import { handleProxy2 } from './stream-buffer';
import { getClientJs, injectScriptTag } from './client-bundle';
import * as log from './logger';
import { RisuSaveType, toRisuSaveType, type HydrationState } from '../shared/types';
import { getUsePlainFetch, extractUsePlainFetch } from './proxy-config-state';
import { initAuth, isAuthReady, issueInternalToken, verifyClientAuth } from './auth';
import { startPeriodicSync, runSync } from './periodic-sync';
import type { SyncResult } from './periodic-sync';
import { dbMigrate } from './dbMigrate';

// --- Route classification ---

const REMOTE_FILE_RE = /^remotes\/(.+)\.local\.bin$/;
const COLDSTORAGE_RE = /^coldstorage\/(.+)$/;
const DATABASE_BIN = 'database/database.bin';
const CHAR_DETAIL_RE = /^\/db\/char-detail\/(.+)$/;

type Route =
  | { type: 'read-database' }
  | { type: 'read-remote'; charId: string }
  | { type: 'read-coldstorage'; key: string }
  | { type: 'write-database' }
  | { type: 'write-remote'; charId: string }
  | { type: 'proxy2' }
  | { type: 'db-client-js' }
  | { type: 'db-char-detail'; charId: string }
  | { type: 'db-char-details' }
  | { type: 'db-batch-remotes' }
  | { type: 'db-file-list-dataset' }
  | { type: 'proxy-config' }
  | { type: 'root-html' }
  | { type: 'list-files' }
  | { type: 'write-asset'; filePath: string }
  | { type: 'remove-asset'; filePath: string }
  | { type: 'remove-file'; filePath: string }
  | { type: 'internal-sql-tables' }
  | { type: 'internal-sql-schema'; table: string }
  | { type: 'internal-sql-query' }
  | { type: 'internal-sync-status' }
  | { type: 'internal-sync-trigger' }
  | { type: 'passthrough' };

function classifyRequest(req: http.IncomingMessage): Route {
  const url = req.url || '';

  // DB Proxy endpoints
  if (url === '/db/client.js' && req.method === 'GET') {
    return { type: 'db-client-js' };
  }

  // File list dataset endpoint
  if (url === '/db/file-list-dataset' && req.method === 'GET') {
    return { type: 'db-file-list-dataset' };
  }

  // Batch remotes endpoint
  if (url === '/db/batch-remotes' && req.method === 'GET') {
    return { type: 'db-batch-remotes' };
  }

  // Char detail endpoints
  if (url === '/db/char-details' && req.method === 'GET') {
    return { type: 'db-char-details' };
  }
  const charDetailMatch = url.match(CHAR_DETAIL_RE);
  if (charDetailMatch && req.method === 'GET') {
    return { type: 'db-char-detail', charId: charDetailMatch[1] };
  }

  // Proxy config (chaining endpoint)
  if (url === '/.proxy/config' && req.method === 'GET') {
    return { type: 'proxy-config' };
  }

  // proxy2
  if ((url === '/proxy2' || url.startsWith('/proxy2?')) && req.method === 'POST') {
    return { type: 'proxy2' };
  }

  // Internal SQL endpoints (monitor 전용)
  if (url === '/_internal/sql/tables' && req.method === 'GET') {
    return { type: 'internal-sql-tables' };
  }
  const sqlSchemaMatch = url.match(/^\/_internal\/sql\/schema\/([^/?]+)/);
  if (sqlSchemaMatch && req.method === 'GET') {
    return { type: 'internal-sql-schema', table: decodeURIComponent(sqlSchemaMatch[1]) };
  }
  if (url === '/_internal/sql/query' && req.method === 'POST') {
    return { type: 'internal-sql-query' };
  }
  if (url === '/_internal/sync/status' && req.method === 'GET') {
    return { type: 'internal-sync-status' };
  }
  if (url === '/_internal/sync/trigger' && req.method === 'POST') {
    return { type: 'internal-sync-trigger' };
  }

  // Root HTML (for script injection)
  if (url === '/' && req.method === 'GET') {
    return { type: 'root-html' };
  }

  // GET /api/list → .meta.meta 필터링
  if (url === '/api/list' && req.method === 'GET') {
    return { type: 'list-files' };
  }

  // GET /api/remove → asset protection / file cache sync
  if (url === '/api/remove' && req.method === 'GET') {
    const filePath = decodeFilePath(req);
    if (filePath && filePath.startsWith('assets/')) {
      return { type: 'remove-asset', filePath };
    }
    if (filePath) {
      return { type: 'remove-file', filePath };
    }
  }

  // File API routes
  if (url === '/api/read' || url === '/api/write') {
    const filePath = decodeFilePath(req);
    if (filePath) {
      const isRead = req.method === 'GET';
      const isWrite = req.method === 'POST';

      if (filePath === DATABASE_BIN) {
        if (isRead) return { type: 'read-database' };
        if (isWrite) return { type: 'write-database' };
      }

      const remoteMatch = filePath.match(REMOTE_FILE_RE);
      if (remoteMatch) {
        if (isRead) return { type: 'read-remote', charId: remoteMatch[1] };
        if (isWrite) return { type: 'write-remote', charId: remoteMatch[1] };
      }

      const coldMatch = filePath.match(COLDSTORAGE_RE);
      if (coldMatch && isRead) {
        return { type: 'read-coldstorage', key: coldMatch[1] };
      }

      // 에셋 write: assets/ 경로의 POST
      if (filePath.startsWith('assets/') && isWrite) {
        return { type: 'write-asset', filePath };
      }
    }
  }

  return { type: 'passthrough' };
}

// --- Hydration state ---

let hydrationState: HydrationState = 'COLD';
const capturedRemotes = new Set<string>();
let expectedRemoteCount = 0;
let storedAuthHeader: string | undefined;
const pendingBatchRequests: Array<{ res: http.ServerResponse; timer: ReturnType<typeof setTimeout> }> = [];

const BATCH_WAIT_TIMEOUT_MS = 30_000;

/** characters 테이블에서 slim JSON을 만들어 batch-remotes 바이너리로 직렬화 */
function serializeBatchRemotesFromDb(db: import('better-sqlite3').Database): Buffer {
  const charRows = getAllCharacterIds(db);
  const entries: Array<{ charId: string; data: Buffer }> = [];

  for (const row of charRows) {
    if (!row.char_id) continue;
    const charRow = getCharacterByCharId(db, row.char_id);
    if (!charRow) continue;
    const slimJson = buildSlimJson(charRow);
    entries.push({ charId: row.char_id, data: Buffer.from(slimJson, 'utf-8') });
  }

  let totalSize = 4;
  for (const e of entries) {
    totalSize += 1 + Buffer.byteLength(e.charId) + 4 + e.data.length;
  }

  const buf = Buffer.alloc(totalSize);
  let off = 0;
  buf.writeUInt32LE(entries.length, off); off += 4;
  for (const e of entries) {
    const charIdBuf = Buffer.from(e.charId, 'utf-8');
    buf[off++] = charIdBuf.length;
    charIdBuf.copy(buf, off); off += charIdBuf.length;
    buf.writeUInt32LE(e.data.length, off); off += 4;
    e.data.copy(buf, off); off += e.data.length;
  }

  return buf;
}

/** characters row → 클라이언트용 slim JSON (heavy 필드 제외 + __strippedFields 마커) */
function buildSlimJson(row: Record<string, unknown>): string {
  const json = characterColumnsToJson(row);

  // heavy 필드를 빈 값으로 대체 + __strippedFields 마커
  const strippedFields: string[] = [];
  for (const field of HEAVY_FIELDS) {
    if (field in json) {
      strippedFields.push(field);
      const val = json[field];
      if (typeof val === 'string') json[field] = '';
      else if (Array.isArray(val)) json[field] = [];
      else if (typeof val === 'object' && val !== null) json[field] = {};
    }
  }
  if (strippedFields.length > 0) {
    json.__strippedFields = strippedFields;
  }

  // image는 character_asset_map에서 복원 (slim에도 image 필요)
  const db = getDb();
  const wsId = row.__ws_id;
  if (typeof wsId === 'string') {
    const assetMap = getAssetMapByCharacter(db, wsId);
    const imageMap = assetMap.find((m) => m.field === 'image');
    if (imageMap && imageMap.__ws_asset_id) {
      const asset = getAssetById(db, imageMap.__ws_asset_id);
      if (asset) {
        json.image = asset.__ws_source_file || `assets/${asset.hash}.png`;
      }
    }
  }

  // chats 배열은 cold marker로 재구성
  if (typeof wsId === 'string') {
    const sessions = getChatSessionsByCharacter(db, wsId);
    json.chats = sessions.map((s) => ({
      message: s.uuid
        ? [{ role: 'char', data: COLD_STORAGE_HEADER + s.uuid, time: Date.now() }]
        : [],
      hypaV2Data: tryParse(s.hypa_v2),
      hypaV3Data: tryParse(s.hypa_v3),
      scriptstate: tryParse(s.script_state),
      localLore: tryParse(s.local_lore),
      folderId: s.folder_id,
      lastDate: s.last_date,
      fmIndex: s.fm_index,
      note: s.note ?? '',
      name: s.chat_name ?? '',
      bookmarks: tryParse(s.bookmarks),
      bookmarkNames: tryParse(s.bookmark_names),
    }));
  }

  return JSON.stringify(json);
}

function tryParse(val: unknown): unknown {
  if (typeof val !== 'string') return val ?? {};
  try { return JSON.parse(val); } catch { return val; }
}

/**
 * If all expected remotes have been captured, transition to HOT and flush
 * pending batch requests. Returns the resolved hydration state so callers
 * can branch without relying on side-effect mutation.
 */
function resolveHydration(): HydrationState {
  if (hydrationState !== 'WARMING') return hydrationState;
  if (capturedRemotes.size < expectedRemoteCount) return hydrationState;

  log.info('Hydration complete. State: HOT', { remotesCached: capturedRemotes.size });
  flushPendingBatchRequests();
  return 'HOT';
}

function flushPendingBatchRequests(): void {
  if (pendingBatchRequests.length === 0) return;
  if (!isDbReady()) return;

  const db = getDb();
  const buf = serializeBatchRemotesFromDb(db);

  log.info('Flushing pending batch-remotes', { count: String(pendingBatchRequests.length) });

  for (const pending of pendingBatchRequests) {
    clearTimeout(pending.timer);
    if (!pending.res.writableEnded) {
      pending.res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(buf.length),
        'cache-control': 'no-cache',
      });
      pending.res.end(buf);
    }
  }
  pendingBatchRequests.length = 0;
}

/** Fetch missing .meta lastUsed values from upstream and store in DB. */
async function hydrateMissingMetaLastUsed(
  db: import('better-sqlite3').Database,
  authHeader: string | undefined,
): Promise<void> {
  const missing = getMetaMissingLastUsed(db);
  if (missing.length === 0) return;

  await Promise.all(missing.map(async (metaPath) => {
    try {
      const body = await fetchFromUpstream(metaPath, authHeader);
      if (body && body.length > 0) {
        const parsed: { lastUsed?: number } = JSON.parse(body.toString('utf-8'));
        if (typeof parsed.lastUsed === 'number') {
          upsertMetaLastUsed(db, metaPath, parsed.lastUsed);
        }
      }
    } catch {
      // Skip — client will fall back to normal fetch
    }
  }));
}

/**
 * 바이너리 없는 에셋을 upstream에서 fetch하여 DB에 저장.
 * 동시 요청 제한(10)으로 upstream 부하 방지.
 */
async function hydrateAssetBinaries(authHeader: string | undefined): Promise<void> {
  if (!isDbReady()) return;
  const db = getDb();

  const missing = db.prepare(
    'SELECT __ws_id, hash, __ws_source_file FROM assets WHERE data IS NULL AND __ws_deleted_at IS NULL',
  ).all() as Array<{ __ws_id: string; hash: string; __ws_source_file: string | null }>;

  if (missing.length === 0) {
    log.info('Asset hydration skipped (no missing binaries)');
    return;
  }

  log.info('Asset hydration started', { total: String(missing.length) });
  const t0 = performance.now();
  let fetched = 0;
  let failed = 0;

  // 동시 10개씩 batch fetch
  const CONCURRENCY = 10;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (asset) => {
      const filePath = asset.__ws_source_file || `assets/${asset.hash}.png`;
      try {
        const body = await fetchFromUpstream(filePath, authHeader);
        if (body && body.length > 0) {
          const ext = filePath.split('.').pop() ?? '';
          const mimeType = ext === 'png' ? 'image/png'
            : ext === 'webp' ? 'image/webp'
            : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'gif' ? 'image/gif'
            : ext === 'mp3' ? 'audio/mpeg'
            : null;
          upsertAsset(db, asset.__ws_id, asset.hash, body, mimeType, filePath);
          fetched++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }));
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  log.info('Asset hydration finished', {
    fetched: String(fetched),
    failed: String(failed),
    total: String(missing.length),
    seconds: elapsed,
  });
}

/** Proactively fetch all remotes from upstream after database.bin is captured. */
async function proactiveHydration(charIds: string[], authHeader: string | undefined): Promise<void> {
  log.info('Proactive hydration started', { remotes: String(charIds.length) });
  const t0 = performance.now();

  await Promise.all(
    charIds.map(async (charId) => {
      if (capturedRemotes.has(charId)) return;
      const body = await fetchFromUpstream(`remotes/${charId}.local.bin`, authHeader);
      if (body && body.length > 0) {
        await captureRemoteFile(body, charId, authHeader);
      } else {
        log.warn('Proactive fetch failed', { charId });
      }
    }),
  );

  log.info('Proactive hydration finished', { ms: (performance.now() - t0).toFixed(0), captured: capturedRemotes.size + '/' + expectedRemoteCount });

  // 캐릭터 hydration 후 바로 에셋 바이너리 fetch
  log.info('Triggering asset hydration after proactive hydration');
  hydrateAssetBinaries(authHeader).catch((e) =>
    log.warn('Asset hydration error', { error: String(e) }),
  );
}

function captureDatabaseBin(body: Buffer, authHeader: string | undefined): void {
  if (!isDbReady()) return;
  const db = getDb();

  const result = parseRisuSave(body);
  if (!result) {
    log.error('Failed to parse database.bin for hydration');
    return;
  }

  storedAuthHeader = authHeader;
  const charIds: string[] = [];

  // 재호출 시 누적 방지
  expectedRemoteCount = 0;
  capturedRemotes.clear();

  inTransaction(db, () => {
    for (const block of result.blocks) {
      const dataStr = block.data.toString('utf-8');
      upsertBlock(db, generateId(db), block.name, block.type, 'database.bin', dataStr, block.hash);
      if (block.type === RisuSaveType.REMOTE) {
        const ptr = parseRemotePointer(block.data);
        if (ptr) {
          expectedRemoteCount++;
          charIds.push(ptr.charId);
        }
      }
      if (block.type === RisuSaveType.ROOT) {
        extractUsePlainFetch(block.data);
      }
    }
  });

  hydrationState = 'WARMING';
  log.info('database.bin captured, State: WARMING', {
    blocks: result.blocks.length,
    remotesExpected: expectedRemoteCount,
  });
  hydrationState = resolveHydration();

  // Proactively fetch all remotes from upstream (non-blocking)
  if (hydrationState !== 'HOT' && charIds.length > 0) {
    proactiveHydration(charIds, authHeader)
      .catch((e) => log.error('Proactive hydration error', { error: String(e) }));
  }
}

async function captureRemoteFile(body: Buffer, charId: string, authHeader: string | undefined): Promise<void> {
  if (!isDbReady()) return;
  const db = getDb();
  const t0 = performance.now();

  const charJsonStr = body.toString('utf-8');
  let charObj: Record<string, unknown>;
  try { charObj = JSON.parse(charJsonStr); } catch { return; }

  const hash = crypto.createHash('sha256').update(charJsonStr).digest('hex');
  const existing = getCharacterByCharId(db, charId);
  const wsId = existing?.__ws_id ?? generateId(db);

  const { columns, unknownFields } = characterJsonToColumns(charObj);
  if (unknownFields.length > 0) {
    log.warn('Hydration: unknown character fields', { charId, fields: unknownFields.join(', ') });
  }

  const t1 = performance.now();

  inTransaction(db, () => {
    upsertCharacter(db, wsId, charId, hash, `remotes/${charId}.local.bin`, columns);
    softDeleteAssetMapByCharacter(db, wsId);
    // 에셋 메타 등록 (inline)
    if (typeof charObj.image === 'string' && charObj.image) {
      const aid = ensureAssetMeta(db, charObj.image);
      if (aid) linkCharacterAsset(db, wsId, aid, 'image', null, null, null, 0);
    }
    if (Array.isArray(charObj.emotionImages)) {
      for (let i = 0; i < charObj.emotionImages.length; i++) {
        const e = charObj.emotionImages[i];
        if (!Array.isArray(e) || e.length < 2) continue;
        const aid = ensureAssetMeta(db, e[1]);
        if (aid) linkCharacterAsset(db, wsId, aid, 'emotionImages', e[0], null, null, i);
      }
    }
    if (Array.isArray(charObj.additionalAssets)) {
      for (let i = 0; i < charObj.additionalAssets.length; i++) {
        const e = charObj.additionalAssets[i];
        if (!Array.isArray(e) || e.length < 2) continue;
        const aid = ensureAssetMeta(db, e[1]);
        if (aid) linkCharacterAsset(db, wsId, aid, 'additionalAssets', e[0], e[2] ?? null, null, i);
      }
    }
    if (Array.isArray(charObj.ccAssets)) {
      for (let i = 0; i < charObj.ccAssets.length; i++) {
        const e = charObj.ccAssets[i] as Record<string, string> | undefined;
        if (!e?.uri) continue;
        const aid = ensureAssetMeta(db, e.uri);
        if (aid) linkCharacterAsset(db, wsId, aid, 'ccAssets', e.name ?? null, e.ext ?? null, e.type ?? null, i);
      }
    }

    // 채팅 정규화
    storeChatsDuringHydration(db, wsId, charObj.chats, authHeader);
  });

  const t2 = performance.now();

  capturedRemotes.add(charId);
  log.info('captureRemoteFile', {
    charId,
    bodyKB: String((body.length / 1024).toFixed(0)),
    parse: (t1 - t0).toFixed(0) + 'ms',
    sqlite: (t2 - t1).toFixed(0) + 'ms',
    captured: capturedRemotes.size + '/' + expectedRemoteCount,
  });
  hydrationState = resolveHydration();
}

function ensureAssetMeta(db: import('better-sqlite3').Database, assetPath: string): string | null {
  const match = assetPath.match(/^assets\/([^.]+)/);
  if (!match) return null;
  const hash = match[1];
  const existing = getAssetByHash(db, hash);
  if (existing) return existing.__ws_id;
  const wsId = generateId(db);
  const ext = assetPath.split('.').pop() ?? '';
  const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : null;
  db.prepare('INSERT INTO assets (__ws_id, hash, mime_type, __ws_source_file) VALUES (?, ?, ?, ?)').run(wsId, hash, mimeType, assetPath);
  return wsId;
}

function storeChatsDuringHydration(
  db: import('better-sqlite3').Database,
  characterWsId: string,
  chats: unknown,
  authHeader: string | undefined,
): void {
  if (!Array.isArray(chats)) return;

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    if (!chat || typeof chat !== 'object') continue;
    const sessionWsId = generateId(db);
    const sessionFields = {
      hypa_v2: JSON.stringify(chat.hypaV2Data ?? {}),
      hypa_v3: JSON.stringify(chat.hypaV3Data ?? {}),
      script_state: JSON.stringify(chat.scriptstate ?? {}),
      local_lore: JSON.stringify(chat.localLore ?? []),
      folder_id: chat.folderId ?? null,
      last_date: chat.lastDate ?? null,
      fm_index: chat.fmIndex ?? null,
      bookmarks: JSON.stringify(chat.bookmarks ?? []),
      bookmark_names: JSON.stringify(chat.bookmarkNames ?? {}),
    };

    if (isColdMarker(chat)) {
      const markerData = chat.message?.[0]?.data ?? '';
      const uuid = markerData.startsWith(COLD_STORAGE_HEADER) ? markerData.slice(COLD_STORAGE_HEADER.length) : null;
      upsertChatSession(db, sessionWsId, characterWsId, uuid, i, sessionFields, null, uuid ? `coldstorage/${uuid}` : null);
      continue;
    }

    const messages: Array<Record<string, unknown>> = Array.isArray(chat.message) ? chat.message : [];
    let uuid: string | null = null;
    if (messages.length > 0) {
      uuid = crypto.randomUUID();
      const coldPayload = JSON.stringify({ message: chat.message, hypaV2Data: chat.hypaV2Data, hypaV3Data: chat.hypaV3Data, scriptstate: chat.scriptstate, localLore: chat.localLore });
      compressColdStorage(coldPayload).then((compressed) => writeToUpstream(`coldstorage/${uuid}`, compressed, authHeader)).catch(() => {});
    }
    const hash = messages.length > 0 ? crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex') : null;
    upsertChatSession(db, sessionWsId, characterWsId, uuid, i, sessionFields, hash, uuid ? `coldstorage/${uuid}` : null);
    if (messages.length > 0) insertChatMessages(db, sessionWsId, messages);
  }
}

// --- Read handlers ---

function handleReadDatabase(req: http.IncomingMessage, res: http.ServerResponse): void {
  const db = getDb();
  const rows = getBlocksBySource(db, 'database.bin');
  if (rows.length === 0) throw new Error('No database.bin blocks in cache');

  const binary = assembleRisuSave(
    rows.map((r) => ({
      name: r.name ?? '',
      type: toRisuSaveType(r.type ?? 0) ?? RisuSaveType.CONFIG,
      data: Buffer.from(r.data ?? '', 'utf-8'),
      compress: true,
    })),
  );

  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(binary.length) });
  res.end(binary);
}

function handleReadRemote(req: http.IncomingMessage, res: http.ServerResponse, charId: string): void {
  const db = getDb();
  const charRow = getCharacterByCharId(db, charId);
  if (!charRow) throw new Error(`Remote ${charId} not in cache`);

  const slimJson = buildSlimJson(charRow);
  const buf = Buffer.from(slimJson, 'utf-8');
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) });
  res.end(buf);
}

async function handleReadColdStorage(req: http.IncomingMessage, res: http.ServerResponse, key: string): Promise<void> {
  const db = getDb();
  const session = getChatSessionByUuid(db, key);
  if (!session) throw new Error(`Cold storage ${key} not in cache`);

  // chat_messages에서 메시지 복원 → cold storage JSON 재구성 → gzip 압축
  const messages = getChatMessagesBySession(db, session.__ws_id);
  const coldPayload = JSON.stringify({
    message: messages.map((m) => ({
      role: m.role,
      data: m.data,
      chatId: m.chat_id,
      saying: m.saying,
      name: m.name,
      time: m.time,
      disabled: m.disabled === 'true' ? true : m.disabled === 'false' ? false : m.disabled === 'allBefore' ? 'allBefore' : undefined,
      isComment: m.is_comment === 1 ? true : undefined,
      otherUser: m.other_user === 1 ? true : undefined,
      generationInfo: tryParse(m.generation_info),
      promptInfo: tryParse(m.prompt_info),
    })),
    hypaV2Data: tryParse(session.hypa_v2),
    hypaV3Data: tryParse(session.hypa_v3),
    scriptstate: tryParse(session.script_state),
    localLore: tryParse(session.local_lore),
  });

  // RisuAI 클라이언트는 fflate.decompress()로 읽으므로 gzip 필수
  const compressed = await compressColdStorage(coldPayload);
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(compressed.length) });
  res.end(compressed);
}

// --- Char detail handlers ---

function handleGetCharDetail(req: http.IncomingMessage, res: http.ServerResponse, charId: string): void {
  const db = getDb();
  const row = getCharacterByCharId(db, charId);
  if (!row) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // heavy 필드만 추출
  const fullJson = characterColumnsToJson(row);
  const detail: Record<string, unknown> = {};
  for (const field of HEAVY_FIELDS) {
    if (field in fullJson) detail[field] = fullJson[field];
  }

  // 에셋 참조 복원 (emotionImages, additionalAssets, ccAssets)
  const assetMap = getAssetMapByCharacter(db, row.__ws_id);
  reconstructAssetFields(db, detail, assetMap);

  const body = JSON.stringify(detail);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function handleGetAllCharDetails(req: http.IncomingMessage, res: http.ServerResponse): void {
  const db = getDb();
  const charRows = getAllCharacterIds(db);

  const result: Record<string, unknown> = {};
  for (const { __ws_id, char_id } of charRows) {
    if (!char_id) continue;
    const row = getCharacterByCharId(db, char_id);
    if (!row) continue;

    const fullJson = characterColumnsToJson(row);
    const detail: Record<string, unknown> = {};
    for (const field of HEAVY_FIELDS) {
      if (field in fullJson) detail[field] = fullJson[field];
    }
    const assetMap = getAssetMapByCharacter(db, __ws_id);
    reconstructAssetFields(db, detail, assetMap);
    result[char_id] = detail;
  }

  const body = JSON.stringify(result);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

/** character_asset_map → RisuAI 에셋 필드 복원 */
function reconstructAssetFields(
  db: import('better-sqlite3').Database,
  json: Record<string, unknown>,
  assetMap: Array<{ field: string | null; label: string | null; ext: string | null; cc_type: string | null; __ws_asset_id: string | null; __ws_order: number | null }>,
): void {
  const emotions: Array<[string, string]> = [];
  const additional: Array<[string, string, string]> = [];
  const cc: Array<{ type: string; uri: string; name: string; ext: string }> = [];

  for (const m of assetMap) {
    if (!m.__ws_asset_id || !m.field) continue;
    const asset = db.prepare('SELECT hash, __ws_source_file FROM assets WHERE __ws_id = ?').get(m.__ws_asset_id) as { hash: string; __ws_source_file: string | null } | undefined;
    if (!asset) continue;
    const assetPath = asset.__ws_source_file || `assets/${asset.hash}.png`;

    if (m.field === 'emotionImages') {
      emotions.push([m.label ?? '', assetPath]);
    } else if (m.field === 'additionalAssets') {
      additional.push([m.label ?? '', assetPath, m.ext ?? '']);
    } else if (m.field === 'ccAssets') {
      cc.push({ type: m.cc_type ?? '', uri: assetPath, name: m.label ?? '', ext: m.ext ?? '' });
    }
  }

  if (emotions.length > 0) json.emotionImages = emotions;
  if (additional.length > 0) json.additionalAssets = additional;
  if (cc.length > 0) json.ccAssets = cc;
}

// --- HTML injection handler ---

function handleRootHtml(req: http.IncomingMessage, res: http.ServerResponse): void {
  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';

      if (!contentType.includes('text/html')) {
        // Not HTML — pass through
        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }

      // Buffer HTML, inject script tag
      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf-8');
        html = injectScriptTag(html);

        const headers = { ...proxyRes.headers };
        headers['content-length'] = String(Buffer.byteLength(html));
        delete headers['content-encoding']; // Injected content is not compressed
        res.writeHead(proxyRes.statusCode!, headers);
        res.end(html);
      });
    },
  );

  req.pipe(proxyReq);
  proxyReq.on('error', (err) => {
    log.error('Root HTML proxy error', { error: err.message });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Bad Gateway');
  });
}

// --- Proxy config handler ---

function handleProxyConfig(req: http.IncomingMessage, res: http.ServerResponse): void {
  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: '/.proxy/config',
      method: 'GET',
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (proxyRes) => {
      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let upstream: Record<string, unknown> = {};
        if (proxyRes.statusCode === 200) {
          try {
            const parsed: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (typeof parsed === 'object' && parsed !== null) {
              upstream = parsed;
            }
          } catch { /* start fresh */ }
        }

        upstream['withSqlite'] = {
          hydrationState,
          usePlainFetch: getUsePlainFetch(),
        };

        const body = JSON.stringify(upstream);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'cache-control': 'no-cache',
        });
        res.end(body);
      });
    },
  );

  proxyReq.on('error', () => {
    const body = JSON.stringify({
      withSqlite: {
        hydrationState,
        usePlainFetch: getUsePlainFetch(),
      },
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-cache',
    });
    res.end(body);
  });

  proxyReq.end();
}

// --- Global error handlers ---

process.on('uncaughtException', (err) => {
  // ECONNRESET / EPIPE from dropped connections — not fatal
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    log.warn('Connection reset (uncaughtException)', { code, message: err.message });
    return;
  }
  log.error('Uncaught exception', { error: err.stack ?? String(err) });
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    log.warn('Connection reset (unhandledRejection)', { code, message: err.message });
    return;
  }
  log.error('Unhandled rejection', { error: err.stack ?? String(err) });
});

// --- Server ---

const cb = createCircuitBreaker();

function main(): void {
  try {
    const db = initDb();
    dbMigrate(db);
    log.info('SQLite initialized', { blocks: blockCount(db) });
  } catch (err) {
    log.error('SQLite init failed, running in pure proxy mode', { error: String(err) });
  }

  const server = http.createServer((req, res) => {
    const route = classifyRequest(req);
    const reqStart = performance.now();

    // Propagate or generate request ID for cross-service tracing
    const rid = (typeof req.headers[REQUEST_ID_HEADER] === 'string' && req.headers[REQUEST_ID_HEADER])
      || (typeof req.headers['cf-ray'] === 'string' && req.headers['cf-ray'])
      || crypto.randomBytes(8).toString('hex');
    req.headers[REQUEST_ID_HEADER] = rid;

    // Ensure client ID header is always present — client patch may not be loaded
    if (typeof req.headers[CLIENT_ID_HEADER] !== 'string') {
      req.headers[CLIENT_ID_HEADER] = `srv-${crypto.randomBytes(8).toString('hex')}`;
    }

    log.debug('Request', { rid, method: req.method, url: req.url, route: route.type });

    res.on('finish', () => {
      const duration = (performance.now() - reqStart).toFixed(0);
      const logFields: Record<string, string | undefined> = { rid, method: req.method, url: req.url, route: route.type, status: String(res.statusCode), ms: duration };
      // file-path 헤더가 있으면 디코딩해서 로그에 포함 (backup 이슈 추적용)
      const rawFp = req.headers[FILE_PATH_HEADER];
      if (typeof rawFp === 'string' && rawFp.length > 0) {
        logFields.filePath = decodeFilePath(req) ?? rawFp;
      }
      log.info('Response', logFields);

      // Sync file_list_cache on write/remove
      if (isDbReady()) {
        const filePath = decodeFilePath(req);
        if (filePath) {
          const url = req.url || '';
          if (url === '/api/write' && req.method === 'POST' && res.statusCode >= 200 && res.statusCode < 300) {
            addToFileListCache(getDb(), filePath);
            // .meta writes: store lastUsed (write time ≈ client's Date.now())
            if (filePath.endsWith('.meta') && filePath.startsWith('remotes/') && !filePath.includes('.meta.meta')) {
              upsertMetaLastUsed(getDb(), filePath, Date.now());
            }
          } else if (url === '/api/remove' && req.method === 'GET') {
            removeFromFileListCache(getDb(), filePath);
          }
        }
      }
    });

    // --- Auth check for /db/* data endpoints ---
    if (route.type.startsWith('db-') && !AUTH_EXEMPT_ROUTES.has(route.type)) {
      const clientAuth = typeof req.headers[RISU_AUTH_HEADER] === 'string'
        ? req.headers[RISU_AUTH_HEADER] : null;
      if (!clientAuth) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'No auth header' }));
        return;
      }
      verifyClientAuth(clientAuth).then((valid) => {
        if (!valid) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        handleRoute();
      }).catch(() => {
        // Auth check failed — fall through to serve anyway (P1: availability)
        handleRoute();
      });
      return;
    }

    handleRoute();

    function handleRoute(): void {
    switch (route.type) {
      // --- DB Proxy endpoints ---
      case 'db-client-js': {
        const js = getClientJs();
        res.writeHead(200, {
          'content-type': 'application/javascript',
          'content-length': String(Buffer.byteLength(js)),
          'cache-control': 'no-cache',
        });
        res.end(js);
        return;
      }

      // --- Char detail endpoints ---
      case 'db-char-detail': {
        if (!isDbReady()) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'DB not ready' }));
          return;
        }
        handleGetCharDetail(req, res, route.charId);
        return;
      }

      case 'db-char-details': {
        if (!isDbReady()) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        handleGetAllCharDetails(req, res);
        return;
      }

      case 'db-file-list-dataset': {
        if (!isDbReady() || !isFileListCacheReady(getDb())) {
          res.writeHead(204);
          res.end();
          return;
        }
        // Hydrate missing .meta lastUsed from upstream before responding
        (async () => {
          try {
            const db = getDb();
            const authHeader = typeof req.headers[RISU_AUTH_HEADER] === 'string'
              ? req.headers[RISU_AUTH_HEADER] : storedAuthHeader;
            await hydrateMissingMetaLastUsed(db, authHeader);

            const files = getFileListCache(db);
            const filtered = files.filter((f) => !f.includes('.meta.meta'));
            const metaEntries = getMetaEntries(db);
            const meta: Record<string, number> = {};
            for (const entry of metaEntries) {
              meta[entry.path] = entry.lastUsed;
            }
            const payload = JSON.stringify({ files: filtered, meta, timestamp: Date.now() });
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(payload)),
              'cache-control': 'no-cache',
            });
            res.end(payload);
          } catch (err) {
            log.warn('file-list-dataset error', { error: String(err) });
            if (!res.headersSent) {
              res.writeHead(204);
              res.end();
            }
          }
        })();
        return;
      }

      case 'db-batch-remotes': {
        if (!isDbReady()) {
          res.writeHead(204);
          res.end();
          return;
        }
        if (hydrationState !== 'HOT') {
          // Hold request until hydration completes (proactive fetch in progress)
          const timer = setTimeout(() => {
            const idx = pendingBatchRequests.findIndex((p) => p.res === res);
            if (idx !== -1) pendingBatchRequests.splice(idx, 1);
            if (!res.writableEnded) {
              log.warn('batch-remotes timeout, sending 204');
              res.writeHead(204);
              res.end();
            }
          }, BATCH_WAIT_TIMEOUT_MS);
          pendingBatchRequests.push({ res, timer });
          res.on('close', () => {
            const idx = pendingBatchRequests.findIndex((p) => p.res === res);
            if (idx !== -1) {
              clearTimeout(pendingBatchRequests[idx].timer);
              pendingBatchRequests.splice(idx, 1);
            }
          });
          return;
        }
        const db = getDb();
        const buf = serializeBatchRemotesFromDb(db);

        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(buf.length),
          'cache-control': 'no-cache',
        });
        res.end(buf);
        return;
      }

      // --- Proxy config ---
      case 'proxy-config': {
        handleProxyConfig(req, res);
        return;
      }

      // --- proxy2 ---
      case 'proxy2': {
        handleProxy2(req, res);
        return;
      }

      // --- HTML injection ---
      case 'root-html': {
        handleRootHtml(req, res);
        return;
      }

      // --- File API routes ---
      case 'read-database': {
        const canAccelerate = isDbReady() && hydrationState !== 'COLD' && cb.allowRequest();
        if (canAccelerate) {
          try {
            handleReadDatabase(req, res);
            cb.onSuccess();
            return;
          } catch (err) {
            cb.onFailure();
            log.warn('read-database fallback to upstream', { error: err instanceof Error ? err.message : String(err) });
          }
        }
        const dbAuthHeader = typeof req.headers[RISU_AUTH_HEADER] === 'string' ? req.headers[RISU_AUTH_HEADER] : undefined;
        forwardAndTee(req, res, (status, body) => {
          if (status < 200 || status >= 300 || body.length === 0 || !isDbReady()) return;
          try {
            if (hydrationState === 'HOT') reconcileDatabaseBin(getDb(), body);
            else captureDatabaseBin(body, dbAuthHeader);
          } catch (e) { log.error('capture/reconcile database.bin error', { error: String(e) }); }
        });
        return;
      }

      case 'read-remote': {
        const canAccelerate = isDbReady() && hydrationState === 'HOT' && cb.allowRequest();
        if (canAccelerate) {
          try {
            handleReadRemote(req, res, route.charId);
            cb.onSuccess();
            return;
          } catch (err) {
            cb.onFailure();
            log.warn('read-remote fallback to upstream', { charId: route.charId, error: err instanceof Error ? err.message : String(err) });
          }
        }
        const remoteAuthHeader = typeof req.headers[RISU_AUTH_HEADER] === 'string' ? req.headers[RISU_AUTH_HEADER] : undefined;
        if (isDbReady() && hydrationState !== 'HOT') {
          // COLD/WARMING: buffer → slim → serve optimized data to client
          forwardBufferAndTransform(req, res, async (status, _headers, body) => {
            if (status < 200 || status >= 300 || body.length === 0) return null;
            try {
              await captureRemoteFile(body, route.charId, remoteAuthHeader);
              // characters 테이블에서 slim JSON 생성하여 응답
              const db = getDb();
              const charRow = getCharacterByCharId(db, route.charId);
              if (charRow) {
                log.debug('Serving slimmed remote during hydration', { charId: route.charId });
                return Buffer.from(buildSlimJson(charRow), 'utf-8');
              }
            } catch (e) { log.error('capture remote error during hydration', { charId: route.charId, error: String(e) }); }
            return null; // fallback to original body
          });
        } else {
          // HOT bypass (reconcile) or DB not ready: tee as before
          forwardAndTee(req, res, (status, body) => {
            if (status < 200 || status >= 300 || body.length === 0 || !isDbReady()) return;
            reconcileRemoteFile(getDb(), body, route.charId, remoteAuthHeader)
              .catch((e) => { log.error('reconcile remote error', { charId: route.charId, error: String(e) }); });
          });
        }
        return;
      }

      case 'read-coldstorage': {
        const canAccelerate = isDbReady() && cb.allowRequest();
        if (canAccelerate) {
          handleReadColdStorage(req, res, route.key).then(
            () => { cb.onSuccess(); },
            (err) => {
              cb.onFailure();
              log.warn('read-coldstorage fallback to upstream', { key: route.key, error: err instanceof Error ? err.message : String(err) });
              forwardRequest(req, res);
            },
          );
          return;
        }
        forwardRequest(req, res);
        return;
      }

      case 'write-database': {
        if (isDbReady()) {
          handleWriteDatabase(req, res, getDb()).catch((err) => {
            log.warn('write-database error, bypassing', { error: err instanceof Error ? err.message : String(err) });
            forwardRequest(req, res);
          });
          return;
        }
        forwardRequest(req, res);
        return;
      }

      case 'write-remote': {
        if (isDbReady()) {
          handleWriteRemote(req, res, route.charId, getDb()).catch((err) => {
            log.warn('write-remote error, bypassing', { charId: route.charId, error: err instanceof Error ? err.message : String(err) });
            forwardRequest(req, res);
          });
          return;
        }
        forwardRequest(req, res);
        return;
      }

      // 에셋 write → upstream 전달 + BLOB 저장 (소프트 딜리트 복구용)
      case 'write-asset': {
        if (isDbReady()) {
          const db = getDb();
          forwardBufferAndTransform(req, res, (status, _headers, body) => {
            if (status >= 200 && status < 300 && body.length > 0) {
              setImmediate(() => {
                try {
                  const match = route.filePath.match(/^assets\/([^.]+)/);
                  if (!match) return;
                  const hash = match[1];
                  const ext = route.filePath.split('.').pop() ?? '';
                  const mimeType = ext === 'png' ? 'image/png'
                    : ext === 'webp' ? 'image/webp'
                    : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                    : ext === 'gif' ? 'image/gif'
                    : ext === 'mp3' ? 'audio/mpeg'
                    : ext === 'wav' ? 'audio/wav'
                    : null;

                  const existing = getAssetByHash(db, hash);
                  const wsId = existing?.__ws_id ?? generateId(db);
                  upsertAsset(db, wsId, hash, body, mimeType, route.filePath);
                  log.debug('Asset binary stored', { filePath: route.filePath, sizeKB: (body.length / 1024).toFixed(0) });
                } catch (err) {
                  log.warn('Asset store failed', { filePath: route.filePath, error: String(err) });
                }
              });
            }
            return null;
          });
          return;
        }
        forwardRequest(req, res);
        return;
      }

      // --- GET /api/list ---
      // SQLite file_list_cache가 있으면 로컬 서빙, 없으면 upstream에서 받아와 캐시 적재.
      // .meta.meta 이상은 필터링 (클라이언트 버그: 체인 무한 성장 방지).
      case 'list-files': {
        if (isDbReady() && isFileListCacheReady(getDb())) {
          try {
            const paths = getFileListCache(getDb());
            const filtered = paths.filter((entry) => !entry.includes('.meta.meta'));
            const body = JSON.stringify({ content: filtered });
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body)),
              'cache-control': 'no-cache',
            });
            res.end(body);
            return;
          } catch (err) {
            log.warn('file_list_cache read failed, falling back to upstream', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Cache miss or error → fetch from upstream and populate cache
        forwardBufferAndTransform(req, res, (status, _headers, body) => {
          if (status < 200 || status >= 300) return null;
          try {
            const data = JSON.parse(body.toString('utf-8'));
            if (data.content && Array.isArray(data.content)) {
              // Populate cache from upstream response
              if (isDbReady()) {
                setImmediate(() => {
                  try {
                    populateFileListCache(getDb(), data.content);
                    log.info('file_list_cache populated', { entries: data.content.length });
                  } catch (err) {
                    log.warn('file_list_cache populate failed', { error: String(err) });
                  }
                });
              }
              data.content = data.content.filter((entry: string) => !entry.includes('.meta.meta'));
            }
            return Buffer.from(JSON.stringify(data), 'utf-8');
          } catch {
            return null;
          }
        });
        return;
      }

      case 'remove-asset': {
        if (isDbReady()) {
          handleRemoveAsset(req, res, route.filePath, getDb());
          return;
        }
        forwardRequest(req, res);
        return;
      }

      case 'remove-file': {
        if (isDbReady()) {
          handleRemoveFile(req, res, route.filePath, getDb());
          return;
        }
        forwardRequest(req, res);
        return;
      }

      // --- Internal SQL endpoints (monitor용) ---
      case 'internal-sql-tables': {
        if (!isDbReady()) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'DB not ready' }));
          return;
        }
        const db = getDb();
        const tables = db.prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all() as Array<{ name: string; type: string }>;
        const payload = JSON.stringify({ tables });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }

      case 'internal-sql-schema': {
        if (!isDbReady()) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'DB not ready' }));
          return;
        }
        const db = getDb();
        const tableName = route.table;
        // 테이블 존재 확인
        const exists = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
        ).get(tableName);
        if (!exists) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `Table not found: ${tableName}` }));
          return;
        }
        const columns = db.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`).all() as Array<{
          cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
        }>;
        const indexRows = db.prepare(`PRAGMA index_list("${tableName.replace(/"/g, '""')}")`).all() as Array<{
          seq: number; name: string; unique: number;
        }>;
        const rowCountRow = db.prepare(
          `SELECT COUNT(*) as count FROM "${tableName.replace(/"/g, '""')}"`,
        ).get() as { count: number };
        const payload = JSON.stringify({
          table: tableName,
          columns,
          indexes: indexRows,
          rowCount: rowCountRow.count,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }

      case 'internal-sql-query': {
        if (!isDbReady()) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'DB not ready' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(body);
            if (typeof parsed !== 'object' || parsed === null || !('sql' in parsed)) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing "sql" field' }));
              return;
            }
            const { sql } = parsed as { sql: string };
            if (typeof sql !== 'string' || sql.trim().length === 0) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'Empty SQL' }));
              return;
            }

            const trimmed = sql.trim().toUpperCase();
            const isRead = trimmed.startsWith('SELECT')
              || trimmed.startsWith('PRAGMA')
              || trimmed.startsWith('EXPLAIN')
              || trimmed.startsWith('WITH');

            const db = getDb();
            const startMs = performance.now();

            if (isRead) {
              const stmt = db.prepare(sql);
              const rows = stmt.all() as Record<string, unknown>[];
              const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
              const elapsed = Math.round(performance.now() - startMs);
              const payload = JSON.stringify({
                type: 'read',
                columns,
                rows: rows.slice(0, 1000),
                totalRows: rows.length,
                truncated: rows.length > 1000,
                elapsedMs: elapsed,
              });
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(payload);
            } else {
              const result = db.prepare(sql).run();
              const elapsed = Math.round(performance.now() - startMs);
              const payload = JSON.stringify({
                type: 'write',
                changes: result.changes,
                lastInsertRowid: typeof result.lastInsertRowid === 'bigint'
                  ? Number(result.lastInsertRowid)
                  : result.lastInsertRowid,
                elapsedMs: elapsed,
              });
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(payload);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn('SQL query error', { error: message });
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: message }));
          }
        });
        return;
      }

      case 'internal-sync-status': {
        const payload = JSON.stringify({
          hydrationState,
          capturedRemotes: capturedRemotes.size,
          expectedRemotes: expectedRemoteCount,
          dbReady: isDbReady(),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }

      case 'internal-sync-trigger': {
        if (!isDbReady()) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'DB not ready' }));
          return;
        }
        runSync(getDb)
          .then((result: SyncResult) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            log.error('Manual sync failed', { error: message });
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: message }));
          });
        return;
      }

      case 'passthrough':
      default:
        forwardRequest(req, res);
        return;
    }
    } // handleRoute
  });

  server.on('clientError', (err, socket) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      socket.destroy();
      return;
    }
    log.warn('Client error', { code, message: err.message });
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  server.listen(PORT, () => {
    log.info('Server started', {
      port: PORT,
      upstream: `${UPSTREAM.protocol}//${UPSTREAM.host}`,
      hydration: hydrationState,
      streamBuffer: 'enabled',
    });

    // Self-auth → API-based proactive hydration (non-blocking)
    (async () => {
      await initAuth().catch((e) => log.warn('Self-auth error', { error: String(e) }));
      if (!isAuthReady() || !isDbReady()) return;

      const token = await issueInternalToken();
      if (!token) return;

      // 1. Hydrate file list cache
      const listBody = await fetchFromUpstream('', token, '/api/list');
      if (listBody && listBody.length > 0) {
        try {
          const data: { content?: string[] } = JSON.parse(listBody.toString('utf-8'));
          if (data.content && Array.isArray(data.content)) {
            populateFileListCache(getDb(), data.content);
            log.info('Proactive file_list_cache hydration', { entries: data.content.length });
          }
        } catch (e) {
          log.warn('File list hydration parse error', { error: String(e) });
        }
      }

      // 2. Hydrate .meta lastUsed
      await hydrateMissingMetaLastUsed(getDb(), token);

      // 3. Hydrate database.bin → blocks + remotes (self-auth 전용 동기 흐름)
      const dbBody = await fetchFromUpstream('database/database.bin', token);
      if (dbBody && dbBody.length > 0) {
        // captureDatabaseBin의 block 저장 부분만 실행 (proactive는 직접 await)
        const result = parseRisuSave(dbBody);
        if (result) {
          const charIds: string[] = [];
          expectedRemoteCount = 0;
          capturedRemotes.clear();

          inTransaction(getDb(), () => {
            for (const block of result.blocks) {
              const dataStr = block.data.toString('utf-8');
              upsertBlock(getDb(), generateId(getDb()), block.name, block.type, 'database.bin', dataStr, block.hash);
              if (block.type === RisuSaveType.REMOTE) {
                const ptr = parseRemotePointer(block.data);
                if (ptr) {
                  expectedRemoteCount++;
                  charIds.push(ptr.charId);
                }
              }
              if (block.type === RisuSaveType.ROOT) {
                extractUsePlainFetch(block.data);
              }
            }
          });

          hydrationState = 'WARMING';
          log.info('database.bin captured (self-auth)', { blocks: result.blocks.length, remotes: expectedRemoteCount });

          // proactiveHydration을 await로 직접 대기
          await proactiveHydration(charIds, token);
          hydrationState = resolveHydration();

          log.info('Self-auth hydration done', {
            state: hydrationState,
            captured: capturedRemotes.size + '/' + expectedRemoteCount,
          });
        }
      }

      // 4. Asset hydration은 proactiveHydration 끝에서 자동 실행

      // Start periodic sync (24h interval)
      startPeriodicSync(getDb);
    })();
  });
}

main();
