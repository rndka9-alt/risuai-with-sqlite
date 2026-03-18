import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import zlib from 'zlib';
import Database from 'better-sqlite3';
import { handleWriteDatabase, handleWriteRemote } from './write-handler';
import { RisuSaveType } from '../shared/types';
import { COLD_STORAGE_HEADER } from './slim';
import { compressColdStorage, decompressColdStorage } from './cold-compat';
import {
  getBlock,
  getCharDetail,
  getChatsByCharId,
  upsertCharDetail,
  blockCount,
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
  isDebug: false,
}));

import { bufferBody, forwardBuffered, writeToUpstream } from './proxy';
import * as log from './logger';

// --- RisuSave binary helpers (from parser.test.ts) ---

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

// --- DB / mock helpers ---

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      name        TEXT PRIMARY KEY,
      type        INTEGER NOT NULL,
      source      TEXT NOT NULL,
      compression INTEGER NOT NULL DEFAULT 0,
      data        BLOB NOT NULL,
      hash        TEXT NOT NULL,
      updated_at  INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS chats (
      uuid        TEXT PRIMARY KEY,
      char_id     TEXT NOT NULL,
      chat_index  INTEGER NOT NULL,
      data        BLOB NOT NULL,
      hash        TEXT NOT NULL,
      updated_at  INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_chats_char ON chats(char_id);
    CREATE TABLE IF NOT EXISTS char_details (
      char_id     TEXT PRIMARY KEY,
      data        BLOB NOT NULL,
      hash        TEXT NOT NULL,
      updated_at  INTEGER DEFAULT (unixepoch())
    );
  `);
  return db;
}

function createMockReq(headers: Record<string, string> = {}): http.IncomingMessage {
  // @ts-expect-error test mock — only headers property is accessed
  return { headers };
}

function createMockRes(): http.ServerResponse {
  // @ts-expect-error test mock — not accessed directly (forwardBuffered is mocked)
  return {};
}

function makeChat(data: string) {
  return {
    message: [{ role: 'char', data, time: Date.now() }],
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

    const req = createMockReq();
    const res = createMockRes();

    await handleWriteDatabase(req, res, db);

    expect(forwardBuffered).toHaveBeenCalledWith(req, res, body);

    await vi.waitFor(() => {
      const block = getBlock(db, 'config_0');
      expect(block).toBeDefined();
      expect(block?.type).toBe(RisuSaveType.CONFIG);
      expect(block?.data.toString('utf-8')).toBe('{"key":"value"}');
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

    const req = createMockReq();
    const res = createMockRes();

    await handleWriteDatabase(req, res, db);

    expect(forwardBuffered).toHaveBeenCalledWith(req, res, body);

    // Background fires and exits early (parse returns null)
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
  it('forwards body and stores cold entries + deep-slim character in SQLite', async () => {
    const character = makeCharacter();
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    const req = createMockReq({ 'risu-auth': 'test-jwt' });
    const res = createMockRes();

    await handleWriteRemote(req, res, 'char-1', db);

    // Forward called with original body (no __strippedFields)
    expect(forwardBuffered).toHaveBeenCalledWith(req, res, body);

    // Wait for background to complete
    await vi.waitFor(() => {
      expect(getBlock(db, 'remote:char-1')).toBeDefined();
    });

    // Deep-slimmed character: heavy fields emptied
    const block = getBlock(db, 'remote:char-1');
    const slimChar = JSON.parse(block!.data.toString('utf-8'));
    expect(slimChar.name).toBe('Alice');
    expect(slimChar.desc).toBe('');
    expect(slimChar.systemPrompt).toBe('');
    expect(slimChar.__strippedFields).toContain('desc');
    expect(slimChar.__strippedFields).toContain('systemPrompt');

    // Chat replaced with cold marker
    const firstMsg = slimChar.chats[0].message[0].data;
    expect(firstMsg.startsWith(COLD_STORAGE_HEADER)).toBe(true);

    // Detail stored (compressed original heavy fields)
    const detail = getCharDetail(db, 'char-1');
    expect(detail).toBeDefined();
    const detailObj = JSON.parse(await decompressColdStorage(detail!.data));
    expect(detailObj.desc).toBe('A character description');
    expect(detailObj.systemPrompt).toBe('You are Alice');

    // Cold chat entry stored
    const chats = getChatsByCharId(db, 'char-1');
    expect(chats).toHaveLength(1);
    const chatObj = JSON.parse(await decompressColdStorage(chats[0].data));
    expect(chatObj.message[0].data).toBe('Hello!');

    // Fire-and-forget cold storage write to upstream
    expect(writeToUpstream).toHaveBeenCalledWith(
      expect.stringMatching(/^coldstorage\//),
      expect.any(Buffer),
      'test-jwt',
    );
  });

  it('merges stored detail back when __strippedFields present', async () => {
    // Pre-populate DB with stored detail
    const detail = { desc: 'Full description', systemPrompt: 'Full prompt' };
    const detailJson = JSON.stringify(detail);
    const detailCompressed = await compressColdStorage(detailJson);
    const detailHash = crypto.createHash('sha256').update(detailJson).digest('hex');
    upsertCharDetail(db, 'char-1', detailCompressed, detailHash);

    // Client sends stripped body
    const character = makeCharacter({
      desc: '',
      systemPrompt: '',
      __strippedFields: ['desc', 'systemPrompt'],
    });
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);

    // Forward should receive MERGED body (not original stripped)
    const forwarded = JSON.parse(getForwardedBody().toString('utf-8'));
    expect(forwarded.desc).toBe('Full description');
    expect(forwarded.systemPrompt).toBe('Full prompt');
    expect(forwarded.__strippedFields).toBeUndefined();
    expect(forwarded.name).toBe('Alice');
  });

  it('warns and forwards original body when no stored detail exists', async () => {
    const character = makeCharacter({
      desc: '',
      __strippedFields: ['desc'],
    });
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);

    // Original body forwarded unchanged
    expect(getForwardedBody()).toBe(body);

    expect(log.warn).toHaveBeenCalledWith(
      '__strippedFields present but no stored detail found',
      expect.objectContaining({ charId: 'char-1' }),
    );
  });

  it('skips already cold-markered chats', async () => {
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
      const chats = getChatsByCharId(db, 'char-1');
      expect(chats).toHaveLength(1);
      expect(chats[0].chatIndex).toBe(1); // only the new chat (index 1)
    });
  });

  it('skips chats with empty messages', async () => {
    const character = makeCharacter({ chats: [{ message: [] }] });
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);

    await vi.waitFor(() => {
      expect(getBlock(db, 'remote:char-1')).toBeDefined();
    });

    expect(getChatsByCharId(db, 'char-1')).toHaveLength(0);
  });

  it('stores deep-slimmed character even when no chats array', async () => {
    const character = { name: 'Bob', chaId: 'char-1', desc: 'minimal' };
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);

    expect(forwardBuffered).toHaveBeenCalled();

    // slimCharacter handles no-chats gracefully → pipeline continues with deep slim + DB
    await vi.waitFor(() => {
      expect(getBlock(db, 'remote:char-1')).toBeDefined();
    });

    // No cold entries created
    expect(getChatsByCharId(db, 'char-1')).toHaveLength(0);
    // But character is still stored (deep-slimmed)
    const block = getBlock(db, 'remote:char-1');
    const stored = JSON.parse(block!.data.toString('utf-8'));
    expect(stored.name).toBe('Bob');
    expect(stored.desc).toBe(''); // heavy field stripped
  });

  it('creates cold entries for multiple chats', async () => {
    const character = makeCharacter({
      chats: [makeChat('Chat 1'), makeChat('Chat 2'), makeChat('Chat 3')],
    });
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(
      createMockReq({ 'risu-auth': 'jwt' }),
      createMockRes(),
      'char-1',
      db,
    );

    await vi.waitFor(() => {
      expect(getChatsByCharId(db, 'char-1')).toHaveLength(3);
    });

    const chats = getChatsByCharId(db, 'char-1');
    expect(chats[0].chatIndex).toBe(0);
    expect(chats[1].chatIndex).toBe(1);
    expect(chats[2].chatIndex).toBe(2);

    // Each cold entry triggers a fire-and-forget upstream write
    expect(writeToUpstream).toHaveBeenCalledTimes(3);
  });

  it('passes auth header to cold storage upstream writes', async () => {
    const character = makeCharacter();
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(
      createMockReq({ 'risu-auth': 'my-jwt-token' }),
      createMockRes(),
      'char-1',
      db,
    );

    await vi.waitFor(() => {
      expect(writeToUpstream).toHaveBeenCalled();
    });

    expect(writeToUpstream).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      'my-jwt-token',
    );
  });

  it('forwards undefined auth when header is absent', async () => {
    const character = makeCharacter();
    const body = Buffer.from(JSON.stringify(character), 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);

    await vi.waitFor(() => {
      expect(writeToUpstream).toHaveBeenCalled();
    });

    expect(writeToUpstream).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      undefined,
    );
  });

  it('handles non-JSON body gracefully in detail merge path', async () => {
    const body = Buffer.from('this is not json', 'utf-8');
    vi.mocked(bufferBody).mockResolvedValue(body);

    await handleWriteRemote(createMockReq(), createMockRes(), 'char-1', db);

    // Still forwarded despite parse failure
    expect(forwardBuffered).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      body,
    );

    expect(log.warn).toHaveBeenCalledWith(
      'Detail merge failed, forwarding original body',
      expect.objectContaining({ charId: 'char-1' }),
    );
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
