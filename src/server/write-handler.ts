import http from 'http';
import Database from 'better-sqlite3';
import { RISU_AUTH_HEADER } from './config';
import { bufferBody, forwardBuffered, writeToUpstream } from './proxy';
import { parseRisuSave, parseRemoteFile, parseRemotePointer } from './parser';
import { slimRemote, mergeCharacterDetail } from './slim';
import { decompressColdStorage } from './cold-compat';
import { upsertBlock, upsertChat, upsertCharDetail, getCharDetail, purgeStaleCharDetails, inTransaction } from './db';
import { RisuSaveType } from '../shared/types';
import * as log from './logger';

/**
 * Handle POST /api/write for database/database.bin.
 *
 * Flow:
 * 1. Buffer the body
 * 2. Forward to upstream FIRST (write-through)
 * 3. On success: parse binary, upsert blocks in SQLite
 *    (incremental save: only upsert present blocks, never delete absent ones)
 */
export async function handleWriteDatabase(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database,
): Promise<void> {
  const body = await bufferBody(req);

  // Forward to upstream first — response goes to client
  forwardBuffered(req, res, body);

  // Background: parse and update SQLite
  setImmediate(() => {
    try {
      const result = parseRisuSave(body);
      if (!result) return;

      // Extract active character IDs from REMOTE blocks
      const activeCharIds = new Set<string>();
      for (const block of result.blocks) {
        if (block.type === RisuSaveType.REMOTE) {
          const ptr = parseRemotePointer(block.data);
          if (ptr) activeCharIds.add(ptr.charId);
        }
      }

      inTransaction(db, () => {
        for (const block of result.blocks) {
          upsertBlock(
            db,
            block.name,
            block.type,
            'database.bin',
            block.compression,
            block.data,
            block.hash,
          );
        }

        // Purge char_details for deleted characters
        if (activeCharIds.size > 0) {
          const purged = purgeStaleCharDetails(db, activeCharIds);
          if (purged.length > 0) {
            log.info('Purged stale char_details', { charIds: purged });
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
 * Flow:
 * 1. Buffer the body
 * 2. If __strippedFields present: merge stored detail back before forwarding
 * 3. Forward (full) body to upstream (write-through)
 * 4. Background: slim chats → deep slim fields → store in SQLite
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

  // Merge stored detail if fields were stripped (client hadn't loaded detail yet)
  try {
    const charJson = body.toString('utf-8');
    const parsed = JSON.parse(charJson);

    if (Array.isArray(parsed.__strippedFields)) {
      const storedDetail = getCharDetail(db, charId);
      if (storedDetail) {
        const detailJson = await decompressColdStorage(storedDetail.data);
        const fullJson = mergeCharacterDetail(charJson, detailJson);
        body = Buffer.from(fullJson, 'utf-8');
        log.debug('Merged stored detail into write body', { charId, strippedFields: parsed.__strippedFields.length });
      } else {
        log.warn('__strippedFields present but no stored detail found', { charId });
      }
    }
  } catch (err) {
    log.warn('Detail merge failed, forwarding original body', { charId, error: String(err) });
  }

  // Forward to upstream (with full data)
  forwardBuffered(req, res, body);

  // Background: parse and update SQLite
  setImmediate(async () => {
    try {
      const block = parseRemoteFile(body, charId);
      if (!block) return;

      const charJson = block.data.toString('utf-8');
      const slimmed = await slimRemote(charJson, charId);

      inTransaction(db, () => {
        upsertBlock(db, `remote:${charId}`, RisuSaveType.CHARACTER_WITH_CHAT, `remote:${charId}`, 0, slimmed.deepSlimBuffer, block.hash);
        upsertCharDetail(db, charId, slimmed.detailCompressed, slimmed.detailHash);
        for (const entry of slimmed.coldEntries) {
          upsertChat(db, entry.uuid, entry.charId, entry.chatIndex, entry.compressed, entry.hash);
        }
      });

      for (const entry of slimmed.coldEntries) {
        writeToUpstream(`coldstorage/${entry.uuid}`, entry.compressed, authHeader);
      }
    } catch (err) {
      log.error('write-remote background parse error', { error: String(err) });
    }
  });
}
