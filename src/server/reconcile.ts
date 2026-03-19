import Database from 'better-sqlite3';
import { getBlockHash, upsertBlock, upsertChat, upsertCharDetail, deleteChatsByCharId, inTransaction } from './db';
import { parseRisuSave, parseRemoteFile, parseRemotePointer } from './parser';
import { slimRemote } from './slim';
import { writeToUpstream } from './proxy';
import { RisuSaveType } from '../shared/types';
import { extractUsePlainFetch } from './proxy-config-state';
import * as log from './logger';

/**
 * Passive reconciliation: compare a freshly fetched blob against SQLite.
 * Called when a bypass read provides new data from upstream.
 *
 * This does NOT actively fetch from upstream (no auth).
 * Instead, it's triggered by tee captures during bypass reads.
 */

/**
 * Reconcile database.bin blocks against what's in SQLite.
 * Returns true if any drift was detected and corrected.
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
        upsertBlock(
          db,
          block.name,
          block.type,
          'database.bin',
          block.compression,
          block.data,
          block.hash,
        );
        driftCount++;
      }

      // Update usePlainFetch from ROOT block (always, regardless of drift)
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
 * Reconcile a remote character file against what's in SQLite.
 * If the hash differs, re-slim the character and update cold entries.
 * Returns true if drift was detected.
 */
export async function reconcileRemoteFile(
  db: Database.Database,
  body: Buffer,
  charId: string,
  authHeader: string | undefined,
): Promise<boolean> {
  const block = parseRemoteFile(body, charId);
  if (!block) return false;

  const existingHash = getBlockHash(db, `remote:${charId}`);
  if (existingHash === block.hash) return false;

  // Hash differs — re-slim
  const charJson = block.data.toString('utf-8');
  const slimmed = await slimRemote(charJson, charId);

  inTransaction(db, () => {
    deleteChatsByCharId(db, charId);
    upsertBlock(db, `remote:${charId}`, RisuSaveType.CHARACTER_WITH_CHAT, `remote:${charId}`, 0, slimmed.deepSlimBuffer, block.hash);
    upsertCharDetail(db, charId, slimmed.detailCompressed, slimmed.detailHash);
    for (const entry of slimmed.coldEntries) {
      upsertChat(db, entry.uuid, entry.charId, entry.chatIndex, entry.compressed, entry.hash);
    }
  });

  for (const entry of slimmed.coldEntries) {
    writeToUpstream(`coldstorage/${entry.uuid}`, entry.compressed, authHeader);
  }

  log.info('Reconcile remote updated', { charId, coldEntries: slimmed.coldEntries.length });

  return true;
}
