import Database from 'better-sqlite3';
import {
  getCharacterByCharId,
  softDeleteCharacter,
  softDeleteChatSessionsByCharacter,
  softDeleteChatMessagesBySession,
  getChatSessionsByCharacter,
  softDeleteAssetMapByCharacter,
  softDeleteBlock,
  removeFromFileListCache,
  getBlocksBySource,
  inTransaction,
} from './db';
import { fetchFromUpstream, writeToUpstreamAsync } from './proxy';
import { assembleRisuSave } from './assembler';
import { RisuSaveType, toRisuSaveType } from '../shared/types';
import * as log from './logger';

export interface DeleteCharacterResult {
  ok: boolean;
  charId: string;
  fileRemoved: boolean;
  error?: string;
}

/**
 * 캐릭터를 완전히 삭제한다.
 *
 * 1. upstream에서 .local.bin / .meta 파일 삭제 시도
 * 2. SQLite soft-delete (character, sessions, messages, asset map, REMOTE block)
 * 3. database.bin 재조립 → upstream에 쓰기 (REMOTE 블록 제거)
 */
export async function deleteCharacter(
  db: Database.Database,
  charId: string,
  authHeader: string | undefined,
): Promise<DeleteCharacterResult> {
  const charRow = getCharacterByCharId(db, charId);
  if (!charRow) {
    return { ok: false, charId, fileRemoved: false, error: 'Character not found in database' };
  }

  // upstream 파일 삭제 시도
  const filePath = `remotes/${charId}.local.bin`;
  const metaPath = `${filePath}.meta`;

  const fileResult = await fetchFromUpstream(filePath, authHeader, '/api/remove');
  const fileRemoved = fileResult !== null;

  // .meta도 삭제 시도 (실패해도 무시)
  await fetchFromUpstream(metaPath, authHeader, '/api/remove').catch(() => null);

  log.info('Character file remove attempt', { charId, fileRemoved });

  // DB soft-delete
  inTransaction(db, () => {
    const sessions = getChatSessionsByCharacter(db, charRow.__ws_id);
    for (const session of sessions) {
      softDeleteChatMessagesBySession(db, session.__ws_id);
    }
    softDeleteChatSessionsByCharacter(db, charRow.__ws_id);
    softDeleteAssetMapByCharacter(db, charRow.__ws_id);
    softDeleteCharacter(db, charRow.__ws_id);
    softDeleteBlock(db, `remote:${charId}`);
    removeFromFileListCache(db, filePath);
    removeFromFileListCache(db, metaPath);
  });

  log.info('Character soft-deleted from DB', { charId, wsId: charRow.__ws_id });

  // database.bin 재조립 (삭제된 REMOTE 블록 제외)
  try {
    const blocks = getBlocksBySource(db, 'database.bin');
    if (blocks.length > 0) {
      const binary = assembleRisuSave(
        blocks.map((r) => ({
          name: r.name ?? '',
          type: toRisuSaveType(r.type ?? 0) ?? RisuSaveType.CONFIG,
          data: Buffer.from(r.data ?? '', 'utf-8'),
          compress: true,
        })),
      );
      await writeToUpstreamAsync('database/database.bin', binary, authHeader);
      log.info('database.bin reassembled and written to upstream', { charId, blocks: blocks.length });
    }
  } catch (err) {
    log.warn('database.bin reassembly failed (character still deleted from DB)', {
      charId,
      error: String(err),
    });
  }

  return { ok: true, charId, fileRemoved };
}
