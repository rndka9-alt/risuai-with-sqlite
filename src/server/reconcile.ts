import crypto from 'crypto';
import Database from 'better-sqlite3';
import { getBlockHash, upsertBlock, upsertChat, deleteChatsByCharId, inTransaction } from './db';
import { parseRisuSave, parseRemoteFile, parseRemotePointer } from './parser';
import { slimCharacter } from './slim';
import { writeToUpstream } from './proxy';
import { RisuSaveType } from '../shared/types';

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
    }
  });

  if (driftCount > 0) {
    console.log(`[Reconcile] database.bin: ${driftCount} blocks updated`);
  }

  return driftCount > 0;
}

/**
 * Reconcile a remote character file against what's in SQLite.
 * If the hash differs, re-slim the character and update cold entries.
 * Returns true if drift was detected.
 */
export function reconcileRemoteFile(
  db: Database.Database,
  body: Buffer,
  charId: string,
  authHeader: string | undefined,
): boolean {
  const block = parseRemoteFile(body, charId);
  if (!block) return false;

  const existingHash = getBlockHash(db, `remote:${charId}`);
  if (existingHash === block.hash) return false;

  // Hash differs — re-slim
  const charJson = block.data.toString('utf-8');
  const { slimJson, coldEntries } = slimCharacter(charJson, charId);
  const slimBuffer = Buffer.from(slimJson, 'utf-8');

  inTransaction(db, () => {
    // Remove old cold entries for this character
    deleteChatsByCharId(db, charId);

    // Store new slim data
    upsertBlock(
      db,
      `remote:${charId}`,
      RisuSaveType.CHARACTER_WITH_CHAT,
      `remote:${charId}`,
      0,
      slimBuffer,
      block.hash,
    );

    // Store new cold entries
    for (const entry of coldEntries) {
      upsertChat(db, entry.uuid, entry.charId, entry.chatIndex, entry.compressed, entry.hash);
    }
  });

  // Write-back cold entries to upstream for FS consistency
  for (const entry of coldEntries) {
    writeToUpstream(`coldstorage/${entry.uuid}`, entry.compressed, authHeader);
  }

  console.log(
    `[Reconcile] remote:${charId} updated (${coldEntries.length} cold entries)`,
  );

  return true;
}
