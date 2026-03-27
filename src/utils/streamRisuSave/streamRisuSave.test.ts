import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { streamRisuSave } from './streamRisuSave';
import { RisuSaveType } from '../../shared/types';

const TMP_DIR = path.join(__dirname, '__test_tmp__');
const TMP_FILE = path.join(TMP_DIR, 'test.bin');

function encodeBlock(type: number, name: string, data: string): Buffer {
  const dataBuf = Buffer.from(data, 'utf-8');
  const nameBuf = Buffer.from(name, 'utf-8');
  const hdr = Buffer.alloc(3 + nameBuf.length + 4);
  hdr[0] = type;
  hdr[1] = 0; // no compression
  hdr[2] = nameBuf.length;
  nameBuf.copy(hdr, 3);
  hdr.writeUInt32LE(dataBuf.length, 3 + nameBuf.length);
  return Buffer.concat([hdr, dataBuf]);
}

function writeTestFile(blocks: Array<{ type: number; name: string; data: string }>): void {
  const header = Buffer.from('RISUSAVE\0', 'utf-8');
  const parts = [header, ...blocks.map((b) => encodeBlock(b.type, b.name, b.data))];
  writeFileSync(TMP_FILE, Buffer.concat(parts));
}

function hashOf(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf-8').digest('hex');
}

beforeAll(() => mkdirSync(TMP_DIR, { recursive: true }));
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

describe('streamRisuSave', () => {
  it('reads all blocks when onHeader returns read', async () => {
    writeTestFile([
      { type: RisuSaveType.CONFIG, name: 'config', data: '{"version":1}' },
      { type: RisuSaveType.ROOT, name: 'root', data: '{"__directory":[]}' },
    ]);

    const received: Array<{ name: string; type: number; data: string }> = [];
    const result = await streamRisuSave(TMP_FILE, {
      onHeader: () => 'read',
      onBlock: (block) => {
        received.push({
          name: block.header.name,
          type: block.header.type,
          data: block.data.toString('utf-8'),
        });
      },
    });

    expect(result.blocksTotal).toBe(2);
    expect(result.blocksRead).toBe(2);
    expect(result.blocksSkipped).toBe(0);
    expect(received[0].name).toBe('config');
    expect(received[0].data).toBe('{"version":1}');
    expect(received[1].name).toBe('root');
  });

  it('skips blocks when onHeader returns skip', async () => {
    const largeData = 'x'.repeat(100000);
    writeTestFile([
      { type: RisuSaveType.CONFIG, name: 'config', data: '{"version":1}' },
      { type: RisuSaveType.CHARACTER_WITH_CHAT, name: 'char1', data: largeData },
      { type: RisuSaveType.ROOT, name: 'root', data: '{}' },
    ]);

    const received: string[] = [];
    const result = await streamRisuSave(TMP_FILE, {
      onHeader: (h) => h.type === RisuSaveType.CHARACTER_WITH_CHAT ? 'skip' : 'read',
      onBlock: (block) => received.push(block.header.name),
    });

    expect(result.blocksTotal).toBe(3);
    expect(result.blocksRead).toBe(2);
    expect(result.blocksSkipped).toBe(1);
    expect(received).toEqual(['config', 'root']);
  });

  it('provides correct hash per block', async () => {
    const data = '{"hello":"world"}';
    writeTestFile([
      { type: RisuSaveType.CONFIG, name: 'cfg', data },
    ]);

    let receivedHash = '';
    await streamRisuSave(TMP_FILE, {
      onHeader: () => 'read',
      onBlock: (block) => { receivedHash = block.hash; },
    });

    expect(receivedHash).toBe(hashOf(data));
  });

  it('exposes dataLen and dataOffset in header', async () => {
    const data1 = 'short';
    const data2 = 'a'.repeat(500);
    writeTestFile([
      { type: RisuSaveType.CONFIG, name: 'a', data: data1 },
      { type: RisuSaveType.ROOT, name: 'b', data: data2 },
    ]);

    const headers: Array<{ name: string; dataLen: number; dataOffset: number }> = [];
    await streamRisuSave(TMP_FILE, {
      onHeader: (h) => { headers.push({ name: h.name, dataLen: h.dataLen, dataOffset: h.dataOffset }); return 'skip'; },
      onBlock: () => {},
    });

    expect(headers[0].dataLen).toBe(Buffer.byteLength(data1, 'utf-8'));
    expect(headers[1].dataLen).toBe(Buffer.byteLength(data2, 'utf-8'));
    // 두 번째 블록의 dataOffset은 첫 번째 블록 뒤에 위치
    expect(headers[1].dataOffset).toBeGreaterThan(headers[0].dataOffset);
  });

  it('handles REMOTE blocks correctly', async () => {
    const remoteData = JSON.stringify({ v: 1, type: 2, name: 'char-uuid-1' });
    writeTestFile([
      { type: RisuSaveType.REMOTE, name: 'char-uuid-1', data: remoteData },
    ]);

    let receivedData = '';
    await streamRisuSave(TMP_FILE, {
      onHeader: () => 'read',
      onBlock: (block) => { receivedData = block.data.toString('utf-8'); },
    });

    expect(JSON.parse(receivedData)).toEqual({ v: 1, type: 2, name: 'char-uuid-1' });
  });

  it('selectively reads only small metadata blocks', async () => {
    const bigChar = 'Z'.repeat(1_000_000);
    writeTestFile([
      { type: RisuSaveType.CONFIG, name: 'config', data: '{}' },
      { type: RisuSaveType.BOTPRESET, name: 'preset', data: '[]' },
      { type: RisuSaveType.CHARACTER_WITH_CHAT, name: 'big-char', data: bigChar },
      { type: RisuSaveType.REMOTE, name: 'remote1', data: '{"v":1}' },
      { type: RisuSaveType.MODULES, name: 'modules', data: '[]' },
      { type: RisuSaveType.ROOT, name: 'root', data: '{}' },
    ]);

    const skipTypes = new Set([RisuSaveType.CHARACTER_WITH_CHAT]);
    const readNames: string[] = [];

    await streamRisuSave(TMP_FILE, {
      onHeader: (h) => skipTypes.has(h.type) ? 'skip' : 'read',
      onBlock: (block) => readNames.push(block.header.name),
    });

    expect(readNames).toEqual(['config', 'preset', 'remote1', 'modules', 'root']);
  });

  it('throws on invalid magic header', async () => {
    writeFileSync(TMP_FILE, Buffer.from('NOT_RISU\0invalid data'));

    await expect(
      streamRisuSave(TMP_FILE, { onHeader: () => 'read', onBlock: () => {} }),
    ).rejects.toThrow('Invalid RISUSAVE magic header');
  });
});
