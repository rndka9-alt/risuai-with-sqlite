import zlib from 'zlib';
import { RisuSaveType } from '../shared/types';

const MAGIC_HEADER = Buffer.from('RISUSAVE\0', 'utf-8');

interface BlockInput {
  name: string;
  type: RisuSaveType;
  data: Buffer;
  compress: boolean;
}

/**
 * Encode a single block into its binary representation (without magic header).
 * Format: type:u8, compression:u8, nameLen:u8, name:string, dataLen:u32LE, data:buffer
 */
export function encodeBlock(input: BlockInput): Buffer {
  const nameBytes = Buffer.from(input.name, 'utf-8');
  let data = input.data;

  const compressionFlag = input.compress ? 1 : 0;
  if (input.compress) {
    data = zlib.gzipSync(data);
  }

  const buf = Buffer.alloc(2 + 1 + nameBytes.length + 4 + data.length);
  let offset = 0;

  buf[offset++] = input.type;
  buf[offset++] = compressionFlag;
  buf[offset++] = nameBytes.length;

  nameBytes.copy(buf, offset);
  offset += nameBytes.length;

  buf.writeUInt32LE(data.length, offset);
  offset += 4;

  data.copy(buf, offset);

  return buf;
}

/**
 * Assemble blocks into a full RisuSave binary.
 * Prepends the magic header and concatenates all encoded blocks.
 */
export function assembleRisuSave(blocks: BlockInput[]): Buffer {
  const parts: Buffer[] = [MAGIC_HEADER];

  for (const block of blocks) {
    parts.push(encodeBlock(block));
  }

  return Buffer.concat(parts);
}
