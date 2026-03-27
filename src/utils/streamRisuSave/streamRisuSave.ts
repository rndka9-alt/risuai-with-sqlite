/**
 * RISUSAVE 바이너리 포맷의 블록 단위 스트리밍 파서.
 *
 * 전체 파일을 메모리에 올리지 않고, 블록 헤더를 먼저 읽어 type/name/dataLen을 파악한 뒤
 * 콜백의 반환값에 따라 data를 읽거나(read) 건너뛴다(skip).
 *
 * 포맷:
 *   RISUSAVE\0 (9 bytes magic header)
 *   [block]*
 *
 * 블록:
 *   type(1) + compression(1) + nameLen(1) + name(nameLen) + dataLen(4 LE) + data(dataLen)
 */

import { createReadStream, type ReadStream } from 'fs';
import { open, type FileHandle } from 'fs/promises';
import zlib from 'zlib';
import crypto from 'crypto';
import { RisuSaveType, toRisuSaveType } from '../../shared/types';

const MAGIC_HEADER = Buffer.from('RISUSAVE\0', 'utf-8');

export interface BlockHeader {
  type: RisuSaveType;
  compression: 0 | 1;
  name: string;
  dataLen: number;
  /** 파일 내에서 data가 시작되는 offset */
  dataOffset: number;
}

export interface BlockData {
  header: BlockHeader;
  /** 압축 해제 후 data */
  data: Buffer;
  hash: string;
}

/** onHeader의 반환값 — 이 블록의 data를 읽을지 건너뛸지 결정 */
export type BlockAction = 'read' | 'skip';

export interface StreamOptions {
  /** 블록 헤더를 읽을 때마다 호출. 반환값으로 data를 읽을지 결정. */
  onHeader: (header: BlockHeader) => BlockAction;
  /** data를 읽은 블록에 대해 호출. */
  onBlock: (block: BlockData) => void;
}

/**
 * RISUSAVE 파일을 블록 단위로 스트리밍 파싱한다.
 *
 * fd 기반 positioned read를 사용하여, 불필요한 블록의 data를 건너뛴다.
 * 4GB 파일이라도 피크 메모리는 (가장 큰 읽기 대상 블록) 수준.
 */
export async function streamRisuSave(
  filePath: string,
  options: StreamOptions,
): Promise<{ blocksTotal: number; blocksRead: number; blocksSkipped: number }> {
  const fh = await open(filePath, 'r');
  try {
    return await parseWithHandle(fh, options);
  } finally {
    await fh.close();
  }
}

async function readExact(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  if (bytesRead < length) {
    throw new Error(`Unexpected EOF: wanted ${length} bytes at offset ${offset}, got ${bytesRead}`);
  }
  return buf;
}

async function parseWithHandle(
  fh: FileHandle,
  options: StreamOptions,
): Promise<{ blocksTotal: number; blocksRead: number; blocksSkipped: number }> {
  // Magic header 검증
  const headerBuf = await readExact(fh, 0, MAGIC_HEADER.length);
  if (!headerBuf.equals(MAGIC_HEADER)) {
    throw new Error('Invalid RISUSAVE magic header');
  }

  let offset = MAGIC_HEADER.length;
  let blocksTotal = 0;
  let blocksRead = 0;
  let blocksSkipped = 0;
  const stat = await fh.stat();
  const fileSize = stat.size;

  while (offset + 7 <= fileSize) {
    // 블록 헤더 최소 크기: type(1) + compression(1) + nameLen(1) + dataLen(4) = 7
    const metaBuf = await readExact(fh, offset, 3);
    const blockType = toRisuSaveType(metaBuf[0]);
    const compression = metaBuf[1];
    const nameLen = metaBuf[2];
    offset += 3;

    if (blockType === null || (compression !== 0 && compression !== 1)) break;

    if (offset + nameLen + 4 > fileSize) break;

    const nameBuf = await readExact(fh, offset, nameLen);
    const name = nameBuf.toString('utf-8');
    offset += nameLen;

    const dataLenBuf = await readExact(fh, offset, 4);
    const dataLen = dataLenBuf.readUInt32LE(0);
    offset += 4;

    if (offset + dataLen > fileSize) break;

    const dataOffset = offset;
    const header: BlockHeader = {
      type: blockType,
      compression: compression as 0 | 1,
      name,
      dataLen,
      dataOffset,
    };

    blocksTotal++;
    const action = options.onHeader(header);

    if (action === 'read') {
      const rawData = await readExact(fh, dataOffset, dataLen);
      let data: Buffer;
      if (compression === 1) {
        data = zlib.gunzipSync(rawData);
      } else {
        data = rawData;
      }
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      options.onBlock({ header, data, hash });
      blocksRead++;
    } else {
      blocksSkipped++;
    }

    offset = dataOffset + dataLen;
  }

  return { blocksTotal, blocksRead, blocksSkipped };
}
