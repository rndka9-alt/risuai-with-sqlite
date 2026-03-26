import crypto from 'crypto';
import { compressColdStorage } from './cold-compat';

export const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';

/**
 * Fields stripped from character JSON for landing-page optimization.
 * These are heavy text/array/object fields not needed for character listing.
 * v2 스키마에서는 characters 테이블의 개별 컬럼으로 저장되며,
 * /db/char-detail/{charId} 엔드포인트를 통해 on-demand 서빙.
 */
export const HEAVY_FIELDS: string[] = [
  'firstMessage',
  'desc',
  'notes',
  'personality',
  'scenario',
  'systemPrompt',
  'postHistoryInstructions',
  'exampleMessage',
  'alternateGreetings',
  'globalLore',
  'customscript',
  'triggerscript',
  'emotionImages',
  'additionalAssets',
  'ccAssets',
  'virtualscript',
  'backgroundHTML',
  'backgroundCSS',
  'additionalText',
  'replaceGlobalNote',
  'sdData',
  'newGenData',
  'bias',
  'depth_prompt',
  'extentions',
  'loreSettings',
  'loreExt',
  'defaultVariables',
  'group_only_greetings',
];

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

export interface DeepSlimResult {
  slimJson: string;   // Character JSON with heavy fields stripped
  detailJson: string; // JSON of extracted heavy fields
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
export async function slimCharacter(characterJson: string, charId: string): Promise<SlimResult> {
  const character = JSON.parse(characterJson);

  if (!Array.isArray(character.chats)) {
    return { slimJson: characterJson, coldEntries: [] };
  }

  // Collect compression tasks first, then run in parallel on libuv thread pool
  const tasks: Array<{
    chatIndex: number;
    uuid: string;
    coldPayload: string;
  }> = [];

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

    tasks.push({ chatIndex: i, uuid, coldPayload });

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

  // Compress all chats in parallel (runs on libuv worker threads)
  const coldEntries = await Promise.all(
    tasks.map(async (task) => {
      const compressed = await compressColdStorage(task.coldPayload);
      const hash = crypto.createHash('sha256').update(task.coldPayload).digest('hex');
      return { uuid: task.uuid, charId, chatIndex: task.chatIndex, compressed, hash };
    }),
  );

  return { slimJson: JSON.stringify(character), coldEntries };
}

/**
 * Strip heavy fields from a character JSON (already chat-slimmed).
 * Extracted fields are returned as a separate JSON blob for storage.
 * A `__strippedFields` marker is added so the write path can detect
 * and merge stored detail back before forwarding to upstream.
 */
export function deepSlimCharacter(characterJson: string): DeepSlimResult {
  const character = JSON.parse(characterJson);
  const detail: Record<string, any> = {};
  const strippedFields: string[] = [];

  for (const field of HEAVY_FIELDS) {
    if (!(field in character) || character[field] === undefined) continue;

    detail[field] = character[field];
    strippedFields.push(field);

    // Replace with type-appropriate empty value
    const val = character[field];
    if (typeof val === 'string') {
      character[field] = '';
    } else if (Array.isArray(val)) {
      character[field] = [];
    } else if (typeof val === 'object' && val !== null) {
      character[field] = {};
    }
  }

  if (strippedFields.length > 0) {
    character.__strippedFields = strippedFields;
  }

  return {
    slimJson: JSON.stringify(character),
    detailJson: JSON.stringify(detail),
  };
}

export interface SlimmedRemote {
  deepSlimBuffer: Buffer;
  detailCompressed: Buffer;
  detailHash: string;
  coldEntries: ColdEntry[];
}

/**
 * Compute-only slim pipeline: chat cold-storage + deep-slim + compress.
 * No DB writes or upstream I/O — callers compose their own side-effects.
 */
export async function slimRemote(charJson: string, charId: string): Promise<SlimmedRemote> {
  const { slimJson: chatSlimJson, coldEntries } = await slimCharacter(charJson, charId);
  const { slimJson: deepSlimJson, detailJson } = deepSlimCharacter(chatSlimJson);
  const deepSlimBuffer = Buffer.from(deepSlimJson, 'utf-8');
  const detailCompressed = await compressColdStorage(detailJson);
  const detailHash = crypto.createHash('sha256').update(detailJson).digest('hex');
  return { deepSlimBuffer, detailCompressed, detailHash, coldEntries };
}

/**
 * Merge stored detail fields back into a character JSON that has __strippedFields.
 * Returns the full character JSON with detail restored and __strippedFields removed.
 */
export function mergeCharacterDetail(characterJson: string, detailJson: string): string {
  const character = JSON.parse(characterJson);
  const detail = JSON.parse(detailJson);

  const stripped: string[] = character.__strippedFields;
  if (!Array.isArray(stripped)) return characterJson;

  for (const field of stripped) {
    if (field in detail) {
      character[field] = detail[field];
    }
  }

  delete character.__strippedFields;
  return JSON.stringify(character);
}
