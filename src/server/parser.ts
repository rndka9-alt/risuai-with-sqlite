import crypto from 'crypto';
import zlib from 'zlib';
import { RisuSaveType, toRisuSaveType, type ParsedBlock } from '../shared/types';
import * as log from './logger';

const MAGIC_HEADER = Buffer.from('RISUSAVE\0', 'utf-8');

function toCompression(val: number): 0 | 1 | null {
  return val === 0 || val === 1 ? val : null;
}

/**
 * Parse a RisuSave binary (database.bin) into blocks.
 * Unlike the sync server's parser, this INCLUDES REMOTE blocks
 * and preserves raw data + compression flags.
 */
export function parseRisuSave(
  buffer: Buffer,
): { blocks: ParsedBlock[]; directory: string[] } | null {
  if (buffer.length < MAGIC_HEADER.length) return null;
  for (let i = 0; i < MAGIC_HEADER.length; i++) {
    if (buffer[i] !== MAGIC_HEADER[i]) return null;
  }

  const blocks: ParsedBlock[] = [];
  let directory: string[] = [];
  let offset = MAGIC_HEADER.length;

  while (offset + 7 <= buffer.length) {
    try {
      const blockType = toRisuSaveType(buffer[offset]);
      const compression = toCompression(buffer[offset + 1]);
      offset += 2;

      if (blockType === null || compression === null) break;

      const nameLen = buffer[offset];
      offset += 1;

      if (offset + nameLen + 4 > buffer.length) break;

      const name = buffer.slice(offset, offset + nameLen).toString('utf-8');
      offset += nameLen;

      const dataLen = buffer.readUInt32LE(offset);
      offset += 4;

      if (offset + dataLen > buffer.length) break;

      const rawData = buffer.slice(offset, offset + dataLen);
      offset += dataLen;

      let data: Buffer;
      if (compression === 1) {
        try {
          data = zlib.gunzipSync(rawData);
        } catch (err) {
          log.debug('Block decompression failed, skipping', { name, error: String(err) });
          continue;
        }
      } else {
        data = rawData;
      }

      const hash = crypto.createHash('sha256').update(data).digest('hex');

      blocks.push({
        name,
        type: blockType,
        compression,
        data,
        hash,
      });

      // Extract __directory from ROOT block
      if (blockType === RisuSaveType.ROOT) {
        try {
          const rootData = JSON.parse(data.toString('utf-8'));
          if (Array.isArray(rootData.__directory)) {
            directory = rootData.__directory;
          }
        } catch (err) {
          log.debug('ROOT block JSON parse failed, skipping directory extraction', { error: String(err) });
        }
      }
    } catch (err) {
      log.debug('Block parse error, stopping', { offset, error: String(err) });
      break;
    }
  }

  return { blocks, directory };
}

/**
 * Parse a remote character file (remotes/{chaId}.local.bin).
 * Remote files are raw UTF-8 JSON text, NOT RisuSave-framed.
 */
export function parseRemoteFile(
  buffer: Buffer,
  charId: string,
): ParsedBlock | null {
  if (buffer.length === 0) return null;

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    name: charId,
    type: RisuSaveType.CHARACTER_WITH_CHAT,
    compression: 0,
    data: buffer,
    hash,
  };
}

/**
 * Extract REMOTE block metadata.
 * REMOTE block data is JSON: { v: 1, type: number, name: string }
 */
export function parseRemotePointer(
  data: Buffer,
): { charId: string; originalType: RisuSaveType } | null {
  try {
    const meta = JSON.parse(data.toString('utf-8'));
    if (meta.v === 1 && typeof meta.name === 'string') {
      return { charId: meta.name, originalType: meta.type };
    }
  } catch (err) {
    log.debug('Remote pointer parse failed', { error: String(err) });
  }
  return null;
}
