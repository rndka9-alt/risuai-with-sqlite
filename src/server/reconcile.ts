import crypto from 'crypto';
import Database from 'better-sqlite3';
import {
  generateId, getBlockHash, upsertBlock, getCharacterHash,
  upsertCharacter, characterJsonToColumns,
  softDeleteChatSessionsByCharacter, softDeleteChatMessagesBySession,
  getChatSessionsByCharacter, softDeleteAssetMapByCharacter,
  getCharacterByCharId, inTransaction,
} from './db';
import { parseRisuSave, parseRemoteFile, parseRemotePointer } from './parser';
import { COLD_STORAGE_HEADER, isColdMarker } from './slim';
import { compressColdStorage } from './cold-compat';
import { writeToUpstream } from './proxy';
import { RisuSaveType } from '../shared/types';
import { extractUsePlainFetch } from './proxy-config-state';
import { streamRisuSave } from '../utils/streamRisuSave';
import * as log from './logger';

// write-handler의 storeChats, extractAndLinkAssets를 재사용하기 위해
// 향후 공통 모듈로 추출 예정. 일단 reconcile에서도 동일 로직 적용.
import { upsertChatSession, insertChatMessages, linkCharacterAsset, getAssetByHash } from './db';

/**
 * Reconcile database.bin blocks against SQLite.
 * Returns true if drift detected.
 */
export function reconcileDatabaseBin(
  db: Database.Database,
  body: Buffer,
): boolean {
  const result = parseRisuSave(body);
  if (!result) return false;

  let driftCount = 0;

  inTransaction(db, () => {
    for (const block of result.blocks) {
      const existingHash = getBlockHash(db, block.name);
      if (existingHash !== block.hash) {
        const dataStr = block.data.toString('utf-8');
        upsertBlock(db, generateId(db), block.name, block.type, 'database.bin', dataStr, block.hash);
        driftCount++;
      }

      if (block.type === RisuSaveType.ROOT) {
        extractUsePlainFetch(block.data);
      }
    }
  });

  if (driftCount > 0) {
    log.info('Reconcile database.bin', { blocksUpdated: driftCount });
  }

  return driftCount > 0;
}

/**
 * Reconcile a remote character file against SQLite.
 * Hash가 다르면 정규화 재저장.
 */
export async function reconcileRemoteFile(
  db: Database.Database,
  body: Buffer,
  charId: string,
  authHeader: string | undefined,
): Promise<boolean> {
  const block = parseRemoteFile(body, charId);
  if (!block) return false;

  const existingHash = getCharacterHash(db, charId);
  if (existingHash === block.hash) return false;

  const charJsonStr = block.data.toString('utf-8');
  const charObj = JSON.parse(charJsonStr);
  const hash = crypto.createHash('sha256').update(charJsonStr).digest('hex');

  const existing = getCharacterByCharId(db, charId);
  const wsId = existing?.__ws_id ?? generateId(db);

  const { columns, unknownFields } = characterJsonToColumns(charObj);
  if (unknownFields.length > 0) {
    log.warn('Reconcile: unknown character fields', { charId, fields: unknownFields.join(', ') });
  }

  inTransaction(db, () => {
    upsertCharacter(db, wsId, charId, hash, `remotes/${charId}.local.bin`, columns);

    // 에셋 매핑 재구성
    softDeleteAssetMapByCharacter(db, wsId);
    reconcileAssets(db, wsId, charObj);

    // 채팅 재구성
    reconcileChats(db, wsId, charObj.chats, authHeader);
  });

  log.info('Reconcile remote updated', { charId });
  return true;
}

/** reconcile용 에셋 추출 — write-handler의 extractAndLinkAssets와 동일 로직 */
function reconcileAssets(
  db: Database.Database,
  characterWsId: string,
  charObj: Record<string, unknown>,
): void {
  if (typeof charObj.image === 'string' && charObj.image) {
    const assetWsId = ensureAssetMeta(db, charObj.image);
    if (assetWsId) linkCharacterAsset(db, characterWsId, assetWsId, 'image', null, null, null, 0);
  }

  if (Array.isArray(charObj.emotionImages)) {
    for (let i = 0; i < charObj.emotionImages.length; i++) {
      const e = charObj.emotionImages[i];
      if (!Array.isArray(e) || e.length < 2) continue;
      const id = ensureAssetMeta(db, e[1]);
      if (id) linkCharacterAsset(db, characterWsId, id, 'emotionImages', e[0], null, null, i);
    }
  }

  if (Array.isArray(charObj.additionalAssets)) {
    for (let i = 0; i < charObj.additionalAssets.length; i++) {
      const e = charObj.additionalAssets[i];
      if (!Array.isArray(e) || e.length < 2) continue;
      const id = ensureAssetMeta(db, e[1]);
      if (id) linkCharacterAsset(db, characterWsId, id, 'additionalAssets', e[0], e[2] ?? null, null, i);
    }
  }

  if (Array.isArray(charObj.ccAssets)) {
    for (let i = 0; i < charObj.ccAssets.length; i++) {
      const e = charObj.ccAssets[i] as Record<string, string> | undefined;
      if (!e?.uri) continue;
      const id = ensureAssetMeta(db, e.uri);
      if (id) linkCharacterAsset(db, characterWsId, id, 'ccAssets', e.name ?? null, e.ext ?? null, e.type ?? null, i);
    }
  }
}

function ensureAssetMeta(db: Database.Database, assetPath: string): string | null {
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
    : null;

  db.prepare('INSERT INTO assets (__ws_id, hash, mime_type, __ws_source_file) VALUES (?, ?, ?, ?)').run(wsId, hash, mimeType, assetPath);
  return wsId;
}

/** reconcile용 채팅 재저장 — write-handler의 storeChats와 동일 로직 */
function reconcileChats(
  db: Database.Database,
  characterWsId: string,
  chats: unknown,
  authHeader: string | undefined,
): void {
  if (!Array.isArray(chats)) return;

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
      chat_id: chat.id ?? null,
      sd_data: chat.sdData ?? null,
      supa_memory_data: chat.supaMemoryData ?? null,
      last_memory: chat.lastMemory ?? null,
      suggest_messages: JSON.stringify(chat.suggestMessages ?? []),
      is_streaming: chat.isStreaming ? 1 : 0,
      modules: JSON.stringify(chat.modules ?? []),
      binded_persona: chat.bindedPersona ?? null,
      bookmarks: JSON.stringify(chat.bookmarks ?? []),
      bookmark_names: JSON.stringify(chat.bookmarkNames ?? {}),
    };

    if (isColdMarker(chat)) {
      const markerData = chat.message?.[0]?.data ?? '';
      const uuid = markerData.startsWith(COLD_STORAGE_HEADER)
        ? markerData.slice(COLD_STORAGE_HEADER.length)
        : null;
      upsertChatSession(db, sessionWsId, characterWsId, uuid, i, sessionFields, null, uuid ? `coldstorage/${uuid}` : null);
      continue;
    }

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

/**
 * database.bin을 블록 단위로 스트리밍 파싱하여 reconcile.
 * CHARACTER_WITH_CHAT 블록은 건너뛰고 메타데이터 블록만 읽는다.
 * 4GB 파일이라도 피크 메모리는 가장 큰 메타데이터 블록 크기 수준.
 */
export async function reconcileDatabaseBinStreaming(
  db: Database.Database,
  fsPath: string,
): Promise<boolean> {
  let driftCount = 0;

  const SKIP_TYPES = new Set([
    RisuSaveType.CHARACTER_WITH_CHAT,
    RisuSaveType.CHARACTER_WITHOUT_CHAT,
    RisuSaveType.CHAT,
  ]);

  const { blocksTotal, blocksRead, blocksSkipped } = await streamRisuSave(fsPath, {
    onHeader: (header) => SKIP_TYPES.has(header.type) ? 'skip' : 'read',
    onBlock: (block) => {
      const existingHash = getBlockHash(db, block.header.name);
      if (existingHash !== block.hash) {
        const dataStr = block.data.toString('utf-8');
        inTransaction(db, () => {
          upsertBlock(db, generateId(db), block.header.name, block.header.type, 'database.bin', dataStr, block.hash);
        });
        driftCount++;
      }
      if (block.header.type === RisuSaveType.ROOT) {
        extractUsePlainFetch(block.data);
      }
    },
  });

  if (driftCount > 0) {
    log.info('Reconcile database.bin (streaming)', {
      blocksUpdated: driftCount,
      blocksTotal,
      blocksRead,
      blocksSkipped,
    });
  }

  return driftCount > 0;
}

/**
 * database.bin을 블록 단위로 스트리밍 파싱하여 capture (initial hydration).
 * CHARACTER_WITH_CHAT 블록은 건너뛰고 메타데이터 + REMOTE 포인터만 읽는다.
 * charIds를 반환하여 호출자가 proactive hydration을 시작할 수 있게 한다.
 */
export async function captureDatabaseBinStreaming(
  db: Database.Database,
  fsPath: string,
): Promise<{ charIds: string[]; remoteCount: number }> {
  const charIds: string[] = [];

  const SKIP_TYPES = new Set([
    RisuSaveType.CHARACTER_WITH_CHAT,
    RisuSaveType.CHARACTER_WITHOUT_CHAT,
    RisuSaveType.CHAT,
  ]);

  await streamRisuSave(fsPath, {
    onHeader: (header) => SKIP_TYPES.has(header.type) ? 'skip' : 'read',
    onBlock: (block) => {
      const dataStr = block.data.toString('utf-8');
      inTransaction(db, () => {
        upsertBlock(db, generateId(db), block.header.name, block.header.type, 'database.bin', dataStr, block.hash);
      });
      if (block.header.type === RisuSaveType.REMOTE) {
        const ptr = parseRemotePointer(block.data);
        if (ptr) charIds.push(ptr.charId);
      }
      if (block.header.type === RisuSaveType.ROOT) {
        extractUsePlainFetch(block.data);
      }
    },
  });

  return { charIds, remoteCount: charIds.length };
}
