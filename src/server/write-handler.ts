import http from 'http';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { RISU_AUTH_HEADER } from './config';
import { bufferBody, forwardBuffered, writeToUpstream } from './proxy';
import { parseRisuSave, parseRemotePointer } from './parser';
import { COLD_STORAGE_HEADER, isColdMarker } from './slim';
import { compressColdStorage } from './cold-compat';
import {
  generateId, upsertBlock, upsertCharacter, getCharacterByCharId,
  characterJsonToColumns, characterColumnsToJson,
  upsertChatSession, insertChatMessages,
  softDeleteChatSessionsByCharacter, softDeleteChatMessagesBySession,
  getChatSessionsByCharacter,
  getAssetByHash, linkCharacterAsset, softDeleteAssetMapByCharacter,
  softDeleteStaleCharacters, inTransaction,
} from './db';
import { RisuSaveType } from '../shared/types';
import { extractUsePlainFetch } from './proxy-config-state';
import * as log from './logger';

/**
 * Handle POST /api/write for database/database.bin.
 *
 * 1. Forward to upstream (write-through)
 * 2. Background: parse binary → upsert blocks + soft delete stale characters
 */
export async function handleWriteDatabase(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database,
): Promise<void> {
  const body = await bufferBody(req);
  forwardBuffered(req, res, body);

  setImmediate(() => {
    try {
      const result = parseRisuSave(body);
      if (!result) return;

      const activeCharIds = new Set<string>();
      for (const block of result.blocks) {
        if (block.type === RisuSaveType.REMOTE) {
          const ptr = parseRemotePointer(block.data);
          if (ptr) activeCharIds.add(ptr.charId);
        }
      }

      inTransaction(db, () => {
        for (const block of result.blocks) {
          const dataStr = block.data.toString('utf-8');
          upsertBlock(db, generateId(db), block.name, block.type, 'database.bin', dataStr, block.hash);
          if (block.type === RisuSaveType.ROOT) {
            extractUsePlainFetch(block.data);
          }
        }

        if (activeCharIds.size > 0) {
          const purged = softDeleteStaleCharacters(db, activeCharIds);
          if (purged.length > 0) {
            log.info('Soft-deleted stale characters', { charIds: purged });
          }
        }
      });
    } catch (err) {
      log.error('write-database background parse error', { error: String(err) });
    }
  });
}

/**
 * Handle POST /api/write for remotes/{charId}.local.bin.
 *
 * 1. If __strippedFields: merge stored fields from DB columns
 * 2. Forward full body to upstream
 * 3. Background: normalize into characters/chat_sessions/chat_messages/assets
 */
export async function handleWriteRemote(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  charId: string,
  db: Database.Database,
): Promise<void> {
  let body = await bufferBody(req);
  const authHeader = typeof req.headers[RISU_AUTH_HEADER] === 'string'
    ? req.headers[RISU_AUTH_HEADER]
    : undefined;

  // __strippedFields → DB 컬럼에서 heavy 필드 복원
  try {
    const charJson = body.toString('utf-8');
    const parsed = JSON.parse(charJson);

    if (Array.isArray(parsed.__strippedFields)) {
      const existingRow = getCharacterByCharId(db, charId);
      if (existingRow) {
        const storedFields = characterColumnsToJson(existingRow);
        for (const field of parsed.__strippedFields) {
          if (field in storedFields) {
            parsed[field] = storedFields[field];
          }
        }
        delete parsed.__strippedFields;
        body = Buffer.from(JSON.stringify(parsed), 'utf-8');
        log.debug('Merged stored fields into write body', { charId });
      } else {
        log.warn('__strippedFields present but no stored character found', { charId });
      }
    }
  } catch (err) {
    log.warn('Detail merge failed, forwarding original body', { charId, error: String(err) });
  }

  forwardBuffered(req, res, body);

  setImmediate(async () => {
    try {
      const charJsonStr = body.toString('utf-8');
      const charObj = JSON.parse(charJsonStr);
      const hash = crypto.createHash('sha256').update(charJsonStr).digest('hex');

      const existing = getCharacterByCharId(db, charId);
      const wsId = existing?.__ws_id ?? generateId(db);

      const { columns, unknownFields } = characterJsonToColumns(charObj);
      if (unknownFields.length > 0) {
        log.warn('Unknown character fields (migration needed)', {
          charId,
          fields: unknownFields.join(', '),
        });
      }

      inTransaction(db, () => {
        upsertCharacter(db, wsId, charId, hash, `remotes/${charId}.local.bin`, columns);
        softDeleteAssetMapByCharacter(db, wsId);
        extractAndLinkAssets(db, wsId, charObj);
        storeChats(db, wsId, charObj.chats, authHeader);
      });
    } catch (err) {
      log.error('write-remote background parse error', { error: String(err) });
    }
  });
}

/** 캐릭터 JSON에서 에셋 참조 추출 → character_asset_map */
function extractAndLinkAssets(
  db: Database.Database,
  characterWsId: string,
  charObj: Record<string, unknown>,
): void {
  // image (단일)
  if (typeof charObj.image === 'string' && charObj.image) {
    const assetWsId = ensureAsset(db, charObj.image);
    if (assetWsId) linkCharacterAsset(db, characterWsId, assetWsId, 'image', null, null, null, 0);
  }

  // emotionImages: [emotionName, assetPath][]
  if (Array.isArray(charObj.emotionImages)) {
    for (let i = 0; i < charObj.emotionImages.length; i++) {
      const entry = charObj.emotionImages[i];
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const assetWsId = ensureAsset(db, entry[1]);
      if (assetWsId) linkCharacterAsset(db, characterWsId, assetWsId, 'emotionImages', entry[0], null, null, i);
    }
  }

  // additionalAssets: [name, assetPath, extension][]
  if (Array.isArray(charObj.additionalAssets)) {
    for (let i = 0; i < charObj.additionalAssets.length; i++) {
      const entry = charObj.additionalAssets[i];
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const assetWsId = ensureAsset(db, entry[1]);
      if (assetWsId) linkCharacterAsset(db, characterWsId, assetWsId, 'additionalAssets', entry[0], entry[2] ?? null, null, i);
    }
  }

  // ccAssets: {type, uri, name, ext}[]
  if (Array.isArray(charObj.ccAssets)) {
    for (let i = 0; i < charObj.ccAssets.length; i++) {
      const entry = charObj.ccAssets[i] as Record<string, string> | undefined;
      if (!entry?.uri) continue;
      const assetWsId = ensureAsset(db, entry.uri);
      if (assetWsId) linkCharacterAsset(db, characterWsId, assetWsId, 'ccAssets', entry.name ?? null, entry.ext ?? null, entry.type ?? null, i);
    }
  }
}

/** 에셋 경로에서 hash 추출, assets 테이블에 메타 등록 (바이너리는 별도) */
function ensureAsset(db: Database.Database, assetPath: string): string | null {
  const match = assetPath.match(/^assets\/([^.]+)/);
  if (!match) return null;
  const hash = match[1];

  const existing = getAssetByHash(db, hash);
  if (existing) return existing.__ws_id;

  const wsId = generateId(db);
  const ext = assetPath.split('.').pop() ?? '';
  const mimeType = ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'gif' ? 'image/gif'
    : ext === 'mp3' ? 'audio/mpeg'
    : ext === 'wav' ? 'audio/wav'
    : null;

  db.prepare('INSERT INTO assets (__ws_id, hash, mime_type, __ws_source_file) VALUES (?, ?, ?, ?)').run(wsId, hash, mimeType, assetPath);
  return wsId;
}

/** 채팅 배열 → chat_sessions + chat_messages 정규화 */
function storeChats(
  db: Database.Database,
  characterWsId: string,
  chats: unknown,
  authHeader: string | undefined,
): void {
  if (!Array.isArray(chats)) return;

  // 기존 세션+메시지 soft delete
  const existingSessions = getChatSessionsByCharacter(db, characterWsId);
  for (const session of existingSessions) {
    softDeleteChatMessagesBySession(db, session.__ws_id);
  }
  softDeleteChatSessionsByCharacter(db, characterWsId);

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
      note: chat.note ?? '',
      chat_name: chat.name ?? '',
      bookmarks: JSON.stringify(chat.bookmarks ?? []),
      bookmark_names: JSON.stringify(chat.bookmarkNames ?? {}),
    };

    // cold storage 마커 → 메시지 없이 세션만 저장
    if (isColdMarker(chat)) {
      const markerData = chat.message?.[0]?.data ?? '';
      const uuid = markerData.startsWith(COLD_STORAGE_HEADER)
        ? markerData.slice(COLD_STORAGE_HEADER.length)
        : null;

      upsertChatSession(db, sessionWsId, characterWsId, uuid, i, sessionFields, null, uuid ? `coldstorage/${uuid}` : null);
      continue;
    }

    // 일반 채팅: cold storage 파일 생성 + 메시지 정규화
    const messages: Array<Record<string, unknown>> = Array.isArray(chat.message) ? chat.message : [];
    const hash = messages.length > 0
      ? crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex')
      : null;

    let uuid: string | null = null;
    if (messages.length > 0) {
      uuid = crypto.randomUUID();
      const coldPayload = JSON.stringify({
        message: chat.message,
        hypaV2Data: chat.hypaV2Data,
        hypaV3Data: chat.hypaV3Data,
        scriptstate: chat.scriptstate,
        localLore: chat.localLore,
      });
      compressColdStorage(coldPayload).then((compressed) => {
        writeToUpstream(`coldstorage/${uuid}`, compressed, authHeader);
      }).catch(() => {});
    }

    upsertChatSession(db, sessionWsId, characterWsId, uuid, i, sessionFields, hash, uuid ? `coldstorage/${uuid}` : null);

    if (messages.length > 0) {
      insertChatMessages(db, sessionWsId, messages);
    }
  }
}
