import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import zlib from 'zlib';
import Database from 'better-sqlite3';
import { handleWriteDatabase, handleWriteRemote } from './write-handler';
import { RisuSaveType } from '../shared/types';
import { COLD_STORAGE_HEADER } from './slim';
import { DDL } from './schema';
import {
  getBlockByName,
  getCharacterByCharId,
  getChatSessionsByCharacter,
  getChatMessagesBySession,
  getAssetMapByCharacter,
  blockCount,
  characterColumnsToJson,
  upsertCharacter,
  characterJsonToColumns,
  generateId,
} from './db';

vi.mock('./proxy', () => ({
  bufferBody: vi.fn(),
  forwardBuffered: vi.fn(),
  writeToUpstream: vi.fn(),
  encodeFilePath: vi.fn((p: string) => Buffer.from(p, 'utf-8').toString('hex')),
}));

vi.mock('./logger', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { bufferBody, forwardBuffered, writeToUpstream } from './proxy';
import * as log from './logger';

// --- RisuSave binary helpers ---

const MAGIC = Buffer.from('RISUSAVE\0', 'utf-8');

function buildBlock(type: number, compression: 0 | 1, name: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf-8');
  let payload = data;
  if (compression === 1) payload = zlib.gzipSync(data);

  const buf = Buffer.alloc(2 + 1 + nameBytes.length + 4 + payload.length);
  let offset = 0;
  buf[offset++] = type;
  buf[offset++] = compression;
  buf[offset++] = nameBytes.length;
  nameBytes.copy(buf, offset); offset += nameBytes.length;
  buf.writeUInt32LE(payload.length, offset); offset += 4;
  payload.copy(buf, offset);
  return buf;
}

function buildRisuSave(blocks: Buffer[]): Buffer {
  return Buffer.concat([MAGIC, ...blocks]);
}

// --- DB / mock helpers ---

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(DDL);
  return db;
}

function createMockReq(headers: Record<string, string> = {}): http.IncomingMessage {
  // @ts-expect-error test mock
  return { headers };
}

function createMockRes(): http.ServerResponse {
  // @ts-expect-error test mock
  return {};
}

function makeChat(data: string) {
  return {
    message: [{ role: 'char', data, time: Date.now(), chatId: 'msg-1' }],
    hypaV2Data: { chunks: [], mainChunks: [], lastMainChunkID: 0 },
    hypaV3Data: { summaries: [] },
    scriptstate: {},
    localLore: [],
  };
}

function makeCharacter(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Alice',
    chaId: 'char-1',
    desc: 'A character description',
    systemPrompt: 'You are Alice',
    chats: [makeChat('Hello!')],
    emotionImages: [['happy', 'assets/abc123.png']],
    ...overrides,
  };
}

function getForwardedBody(): Buffer {
  const calls = vi.mocked(forwardBuffered).mock.calls;
  const body = calls[0]?.[2];
  if (!body) throw new Error('forwardBuffered was not called');
  return body;
}

// --- Tests ---

let db: Database.Database;

beforeEach(() => {
  vi.resetAllMocks();
  db = createTestDb();
});

// ==================== handleWriteDatabase ====================

describe('handleWriteDatabase', () => {
  it('forwards body to upstream and upserts blocks in SQLite', async () => {
    const data = Buffer.from('{"key":"value"}');
    const body = buildRisuSave([
      buildBlock(RisuSaveType.CONFIG, 0, 'config_0', data),
    ]);
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteDatabase(createMockReq(), createMockRes(), db);
    expect(forwardBuffered).toHaveBeenCalled();

    await vi.waitFor(() => {
      const block = getBlockByName(db, 'config_0');
      expect(block).toBeDefined();
      expect(block?.type).toBe(RisuSaveType.CONFIG);
      expect(block?.data).toBe('{"key":"value"}');
    });
  });

  it('upserts multiple blocks in a single transaction', async () => {
    const body = buildRisuSave([
      buildBlock(RisuSaveType.CONFIG, 0, 'c0', Buffer.from('{}')),
      buildBlock(RisuSaveType.ROOT, 0, 'r0', Buffer.from('{"__directory":[]}')),
      buildBlock(RisuSaveType.REMOTE, 0, 'rem0', Buffer.from('{"v":1}')),
    ]);
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteDatabase(createMockReq(), createMockRes(), db);

    await vi.waitFor(() => {
      expect(blockCount(db)).toBe(3);
    });
  });

  it('forwards to upstream even when parse returns null', async () => {
    const body = Buffer.from('not a valid RisuSave binary');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteDatabase(createMockReq(), createMockRes(), db);

    expect(forwardBuffered).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(blockCount(db)).toBe(0);
  });

  it('logs error on background failure without crashing', async () => {
    const body = buildRisuSave([
      buildBlock(RisuSaveType.CONFIG, 0, 'c0', Buffer.from('{}')),
    ]);
    vi.mocked(bufferBody).mockResolvedValue(body);

    const closedDb = createTestDb();
    closedDb.close();

    await handleWriteDatabase(createMockReq(), createMockRes(), closedDb);
    expect(forwardBuffered).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(log.error).toHaveBeenCalledWith(
        'write-database background parse error',
        expect.objectContaining({ error: expect.any(String) }),
      );
    });
  });
});

// ==================== handleWriteRemote ====================

describe('handleWriteRemote', () => {
  it('forwards body and normalizes character into v2 tables', async () => {
    const character = makeCharacter();
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq({ 'risu-auth': 'test-jwt' }), createMockRes(), 'char-1', db);
    expect(forwardBuffered).toHaveBeenCalled();

    await vi.waitFor(() => {
      const charRow = getCharacterByCharId(db, 'char-1');
      expect(charRow).toBeDefined();
      expect(charRow?.name).toBe('Alice');
    });

    // characters 테이블에 heavy 필드도 저장됨
    const charRow = getCharacterByCharId(db, 'char-1')!;
    const json = characterColumnsToJson(charRow);
    expect(json.desc).toBe('A character description');
    expect(json.systemPrompt).toBe('You are Alice');

    // 에셋 매핑 저장됨
    const assetMap = getAssetMapByCharacter(db, charRow.__ws_id);
    expect(assetMap.length).toBeGreaterThanOrEqual(1);
    const emotionEntry = assetMap.find((m) => m.field === 'emotionImages');
    expect(emotionEntry?.label).toBe('happy');

    // 채팅 세션 + 메시지 저장됨
    const sessions = getChatSessionsByCharacter(db, charRow.__ws_id);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const messages = getChatMessagesBySession(db, sessions[0].__ws_id);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].data).toBe('Hello!');
  });

  it('merges stored fields when __strippedFields present', async () => {
    // Pre-populate character with full data
    const wsId = generateId(db);
    const { columns } = characterJsonToColumns({
      chaId: 'char-1', name: 'Alice',
      desc: 'Full description', systemPrompt: 'Full prompt',
    });
    upsertCharacter(db, wsId, 'char-1', 'hash1', null, columns);

    // Client sends stripped body
    const character = makeCharacter({
      desc: '',
      systemPrompt: '',
      __strippedFields: ['desc', 'systemPrompt'],
    });
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);

    // Forwarded body should have merged fields
    const forwarded = JSON.parse(getForwardedBody().toString('utf-8'));
    expect(forwarded.desc).toBe('Full description');
    expect(forwarded.systemPrompt).toBe('Full prompt');
    expect(forwarded.__strippedFields).toBeUndefined();
  });

  it('warns when no stored character for __strippedFields', async () => {
    const character = makeCharacter({ desc: '', __strippedFields: ['desc'] });
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);
    expect(getForwardedBody()).toBe(body);
    expect(log.warn).toHaveBeenCalledWith(
      '__strippedFields present but no stored character found',
      expect.objectContaining({ charId: 'char-1' }),
    );
  });

  it('handles cold-markered chats without creating messages', async () => {
    const character = makeCharacter({
      chats: [
        { message: [{ role: 'char', data: COLD_STORAGE_HEADER + 'existing-uuid' }] },
        makeChat('New message'),
      ],
    });
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);

    await vi.waitFor(() => {
      const charRow = getCharacterByCharId(db, 'char-1');
      expect(charRow).toBeDefined();
      const sessions = getChatSessionsByCharacter(db, charRow!.__ws_id);
      expect(sessions).toHaveLength(2);
      // cold marker 세션은 uuid만, 메시지는 없음
      expect(sessions[0].uuid).toBe('existing-uuid');
      const coldMessages = getChatMessagesBySession(db, sessions[0].__ws_id);
      expect(coldMessages).toHaveLength(0);
      // 일반 세션은 메시지 있음
      const newMessages = getChatMessagesBySession(db, sessions[1].__ws_id);
      expect(newMessages.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('stores character even without chats array', async () => {
    const character = { name: 'Bob', chaId: 'char-1', desc: 'minimal' };
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);
    expect(forwardBuffered).toHaveBeenCalled();

    await vi.waitFor(() => {
      const charRow = getCharacterByCharId(db, 'char-1');
      expect(charRow).toBeDefined();
      expect(charRow?.name).toBe('Bob');
    });
  });

  it('warns on unknown character fields', async () => {
    const character = makeCharacter({ totallyNewField: 'surprise!' });
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);

    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        'Unknown character fields (migration needed)',
        expect.objectContaining({ fields: expect.stringContaining('totallyNewField') }),
      );
    });
  });

  it('logs error on background failure without crashing', async () => {
    const character = makeCharacter();
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    const closedDb = createTestDb();
    closedDb.close();

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', closedDb);
    expect(forwardBuffered).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(log.error).toHaveBeenCalledWith(
        'write-remote background parse error',
        expect.objectContaining({ error: expect.any(String) }),
      );
    });
  });
});
