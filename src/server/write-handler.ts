import http from 'http';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { bufferBody, forwardBuffered, writeToUpstream } from './proxy';
import { parseRisuSave, parseRemoteFile } from './parser';
import { slimCharacter, isColdMarker, COLD_STORAGE_HEADER } from './slim';
import { compressColdStorage } from './cold-compat';
import { upsertBlock, upsertChat, inTransaction } from './db';
import { RisuSaveType } from '../shared/types';

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
      });
    } catch (err) {
      console.error('[DB-Proxy] write-database background parse error:', err);
    }
  });
}

/**
 * Handle POST /api/write for remotes/{charId}.local.bin.
 *
 * Flow:
 * 1. Buffer the body
 * 2. Forward to upstream FIRST (write-through)
 * 3. On success: parse character JSON
 *    - Chats with cold markers → skip (DB already has real data)
 *    - Chats with real messages → generate new cold entries, update slim data
 *    - Write cold entries to upstream for FS consistency
 */
export async function handleWriteRemote(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  charId: string,
  db: Database.Database,
): Promise<void> {
  const body = await bufferBody(req);
  const authHeader = typeof req.headers['risu-auth'] === 'string'
    ? req.headers['risu-auth']
    : undefined;

  // Forward to upstream first
  forwardBuffered(req, res, body);

  // Background: parse and update SQLite
  setImmediate(() => {
    try {
      const block = parseRemoteFile(body, charId);
      if (!block) return;

      const charJson = block.data.toString('utf-8');
      let character: any;
      try {
        character = JSON.parse(charJson);
      } catch {
        return;
      }

      if (!Array.isArray(character.chats)) return;

      const newColdEntries: Array<{
        uuid: string;
        charId: string;
        chatIndex: number;
        compressed: Buffer;
        hash: string;
      }> = [];

      // Process each chat
      for (let i = 0; i < character.chats.length; i++) {
        const chat = character.chats[i];

        if (isColdMarker(chat)) {
          // Cold marker → DB already has real data, skip
          continue;
        }

        if (!Array.isArray(chat.message) || chat.message.length === 0) continue;

        // Real messages → create cold entry
        const uuid = crypto.randomUUID();
        const coldPayload = JSON.stringify({
          message: chat.message,
          hypaV2Data: chat.hypaV2Data,
          hypaV3Data: chat.hypaV3Data,
          scriptstate: chat.scriptstate,
          localLore: chat.localLore,
        });

        const compressed = compressColdStorage(coldPayload);
        const hash = crypto.createHash('sha256').update(coldPayload).digest('hex');

        newColdEntries.push({ uuid, charId, chatIndex: i, compressed, hash });

        // Replace chat with marker for slim version
        chat.message = [
          { role: 'char', data: COLD_STORAGE_HEADER + uuid, time: Date.now() },
        ];
        chat.hypaV2Data = { chunks: [], mainChunks: [], lastMainChunkID: 0 };
        chat.hypaV3Data = { summaries: [] };
        chat.scriptstate = {};
        chat.localLore = [];
      }

      const slimJson = JSON.stringify(character);
      const slimBuffer = Buffer.from(slimJson, 'utf-8');

      inTransaction(db, () => {
        // Update slim character data
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
        for (const entry of newColdEntries) {
          upsertChat(db, entry.uuid, entry.charId, entry.chatIndex, entry.compressed, entry.hash);
        }
      });

      // Write cold entries to upstream for FS consistency (fire-and-forget)
      for (const entry of newColdEntries) {
        writeToUpstream(`coldstorage/${entry.uuid}`, entry.compressed, authHeader);
      }
    } catch (err) {
      console.error('[DB-Proxy] write-remote background parse error:', err);
    }
  });
}
