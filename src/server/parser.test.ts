import { describe, it, expect } from 'vitest';
import zlib from 'zlib';
import crypto from 'crypto';
import { parseRisuSave, parseRemoteFile, parseRemotePointer } from './parser';
import { RisuSaveType } from '../shared/types';

const MAGIC = Buffer.from('RISUSAVE\0', 'utf-8');

function buildBlock(type: number, compression: 0 | 1, name: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf-8');
  let payload = data;
  if (compression === 1) {
    payload = zlib.gzipSync(data);
  }

  const buf = Buffer.alloc(2 + 1 + nameBytes.length + 4 + payload.length);
  let offset = 0;
  buf[offset++] = type;
  buf[offset++] = compression;
  buf[offset++] = nameBytes.length;
  nameBytes.copy(buf, offset);
  offset += nameBytes.length;
  buf.writeUInt32LE(payload.length, offset);
  offset += 4;
  payload.copy(buf, offset);

  return buf;
}

function buildRisuSave(blocks: Buffer[]): Buffer {
  return Buffer.concat([MAGIC, ...blocks]);
}

describe('parseRisuSave', () => {
  it('parses a simple uncompressed block', () => {
    const data = Buffer.from('{"key":"value"}', 'utf-8');
    const block = buildBlock(RisuSaveType.CONFIG, 0, 'config_0', data);
    const binary = buildRisuSave([block]);

    const result = parseRisuSave(binary);
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks[0].name).toBe('config_0');
    expect(result!.blocks[0].type).toBe(RisuSaveType.CONFIG);
    expect(result!.blocks[0].compression).toBe(0);
    expect(result!.blocks[0].data.toString('utf-8')).toBe('{"key":"value"}');
  });

  it('parses a gzip-compressed block', () => {
    const data = Buffer.from('{"compressed":true}', 'utf-8');
    const block = buildBlock(RisuSaveType.ROOT, 1, 'root_0', data);
    const binary = buildRisuSave([block]);

    const result = parseRisuSave(binary);
    expect(result).not.toBeNull();
    expect(result!.blocks[0].compression).toBe(1);
    expect(result!.blocks[0].data.toString('utf-8')).toBe('{"compressed":true}');
  });

  it('extracts __directory from ROOT block', () => {
    const rootData = JSON.stringify({ __directory: ['char1', 'char2'] });
    const block = buildBlock(RisuSaveType.ROOT, 0, 'root_0', Buffer.from(rootData, 'utf-8'));
    const binary = buildRisuSave([block]);

    const result = parseRisuSave(binary);
    expect(result!.directory).toEqual(['char1', 'char2']);
  });

  it('parses multiple blocks', () => {
    const b1 = buildBlock(RisuSaveType.CONFIG, 0, 'c0', Buffer.from('{}'));
    const b2 = buildBlock(RisuSaveType.ROOT, 0, 'r0', Buffer.from('{}'));
    const b3 = buildBlock(RisuSaveType.REMOTE, 0, 'rem0', Buffer.from('{}'));
    const binary = buildRisuSave([b1, b2, b3]);

    const result = parseRisuSave(binary);
    expect(result!.blocks).toHaveLength(3);
  });

  it('returns null for invalid magic header', () => {
    const binary = Buffer.from('NOTVALID\0', 'utf-8');
    expect(parseRisuSave(binary)).toBeNull();
  });

  it('returns null for too-short buffer', () => {
    expect(parseRisuSave(Buffer.alloc(3))).toBeNull();
  });

  it('stops on unknown block type', () => {
    const validBlock = buildBlock(RisuSaveType.CONFIG, 0, 'c0', Buffer.from('{}'));
    const invalidBlock = buildBlock(99, 0, 'bad', Buffer.from('{}'));
    const binary = buildRisuSave([validBlock, invalidBlock]);

    const result = parseRisuSave(binary);
    expect(result!.blocks).toHaveLength(1);
  });

  it('computes SHA-256 hash of uncompressed data', () => {
    const data = Buffer.from('test data', 'utf-8');
    const expectedHash = crypto.createHash('sha256').update(data).digest('hex');
    const block = buildBlock(RisuSaveType.CONFIG, 0, 'c0', data);
    const binary = buildRisuSave([block]);

    const result = parseRisuSave(binary);
    expect(result!.blocks[0].hash).toBe(expectedHash);
  });
});

describe('parseRemoteFile', () => {
  it('parses a remote character file', () => {
    const charJson = JSON.stringify({ name: 'Alice', chaId: 'char-1' });
    const buffer = Buffer.from(charJson, 'utf-8');

    const result = parseRemoteFile(buffer, 'char-1');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('char-1');
    expect(result!.type).toBe(RisuSaveType.CHARACTER_WITH_CHAT);
    expect(result!.data.toString('utf-8')).toBe(charJson);
  });

  it('returns null for empty buffer', () => {
    expect(parseRemoteFile(Buffer.alloc(0), 'char-1')).toBeNull();
  });
});

describe('parseRemotePointer', () => {
  it('extracts charId from REMOTE block data', () => {
    const data = Buffer.from(JSON.stringify({ v: 1, type: 2, name: 'char-1' }));
    const result = parseRemotePointer(data);
    expect(result).not.toBeNull();
    expect(result!.charId).toBe('char-1');
    expect(result!.originalType).toBe(RisuSaveType.CHARACTER_WITH_CHAT);
  });

  it('returns null for invalid data', () => {
    expect(parseRemotePointer(Buffer.from('not json'))).toBeNull();
    expect(parseRemotePointer(Buffer.from(JSON.stringify({ v: 2 })))).toBeNull();
  });
});
