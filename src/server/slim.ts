import crypto from 'crypto';
import { compressColdStorage } from './cold-compat';

export const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';

export interface ColdEntry {
  uuid: string;
  charId: string;
  chatIndex: number;
  compressed: Buffer; // gzip-compressed JSON
  hash: string; // SHA-256 of uncompressed JSON
}

export interface SlimResult {
  slimJson: string; // Character JSON with chats replaced by cold markers
  coldEntries: ColdEntry[];
}

/**
 * Check if a chat is already cold-stored (has a cold marker as first message).
 */
export function isColdMarker(chat: { message?: Array<{ data?: string }> }): boolean {
  return chat.message?.[0]?.data?.startsWith(COLD_STORAGE_HEADER) === true;
}

/**
 * Extract cold storage UUID from a marker string.
 */
export function extractColdKey(markerData: string): string | null {
  if (!markerData.startsWith(COLD_STORAGE_HEADER)) return null;
  return markerData.slice(COLD_STORAGE_HEADER.length);
}

/**
 * Process a character: replace all chat messages with cold storage markers.
 * Returns the slim JSON and the extracted cold entries.
 */
export function slimCharacter(characterJson: string, charId: string): SlimResult {
  const character = JSON.parse(characterJson);
  const coldEntries: ColdEntry[] = [];

  if (!Array.isArray(character.chats)) {
    return { slimJson: characterJson, coldEntries };
  }

  for (let i = 0; i < character.chats.length; i++) {
    const chat = character.chats[i];

    // Already has a cold marker — skip
    if (isColdMarker(chat)) continue;

    // No messages or empty — skip
    if (!Array.isArray(chat.message) || chat.message.length === 0) continue;

    const uuid = crypto.randomUUID();

    // Build cold storage payload (matches RisuAI's makeColdData format)
    const coldPayload = JSON.stringify({
      message: chat.message,
      hypaV2Data: chat.hypaV2Data,
      hypaV3Data: chat.hypaV3Data,
      scriptstate: chat.scriptstate,
      localLore: chat.localLore,
    });

    const compressed = compressColdStorage(coldPayload);
    const hash = crypto.createHash('sha256').update(coldPayload).digest('hex');

    coldEntries.push({ uuid, charId, chatIndex: i, compressed, hash });

    // Replace chat with cold marker (matches RisuAI's makeColdData behavior)
    chat.message = [
      {
        role: 'char',
        data: COLD_STORAGE_HEADER + uuid,
        time: Date.now(),
      },
    ];
    chat.hypaV2Data = { chunks: [], mainChunks: [], lastMainChunkID: 0 };
    chat.hypaV3Data = { summaries: [] };
    chat.scriptstate = {};
    chat.localLore = [];
  }

  return { slimJson: JSON.stringify(character), coldEntries };
}
