import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import Database from 'better-sqlite3';
import { handleBatchWrite } from './batch-write-handler';

vi.mock('./proxy', () => ({
  bufferBody: vi.fn(),
  forwardBuffered: vi.fn(),
  writeToUpstream: vi.fn(),
  writeToUpstreamWithStatus: vi.fn(),
  encodeFilePath: vi.fn((p: string) => Buffer.from(p, 'utf-8').toString('hex')),
}));

vi.mock('./logger', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock slim to avoid heavy processing in tests
vi.mock('./slim', () => ({
  slimRemote: vi.fn().mockResolvedValue({
    deepSlimBuffer: Buffer.from('slimmed'),
    detailCompressed: Buffer.from('detail'),
    detailHash: 'detailhash',
    coldEntries: [],
  }),
  mergeCharacterDetail: vi.fn((_charJson: string, _detailJson: string) => _charJson),
  COLD_STORAGE_HEADER: '\uEF01COLDSTORAGE\uEF01',
}));

vi.mock('./parser', () => ({
  parseRemoteFile: vi.fn().mockReturnValue({
    name: 'test-char',
    type: 2,
    data: Buffer.from('{}'),
    hash: 'testhash',
    compression: 0,
  }),
}));

import { bufferBody, writeToUpstreamWithStatus } from './proxy';

// --- Helpers ---

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
    CREATE TABLE IF NOT EXISTS file_list_cache (
      path        TEXT PRIMARY KEY,
      last_used   INTEGER,
      updated_at  INTEGER DEFAULT (unixepoch())
    );
  `);
  return db;
}

function createMockReq(headers: Record<string, string> = {}): http.IncomingMessage {
  // @ts-expect-error test mock — only headers property is accessed
  return { headers };
}

interface MockResHolder {
  res: http.ServerResponse;
  statusCode: number;
  responseBody: string;
}

function createMockRes(): MockResHolder {
  const holder: MockResHolder = {
    // @ts-expect-error test mock
    res: null,
    statusCode: 0,
    responseBody: '',
  };
  const mock = {
    writeHead(code: number, _headers?: Record<string, string>) { holder.statusCode = code; },
    end(data?: string) { if (data) holder.responseBody = data; },
  };
  // @ts-expect-error test mock — only writeHead/end are accessed
  holder.res = mock;
  return holder;
}

/**
 * Build a batch-write binary payload.
 */
function buildBatchPayload(
  entries: Array<{ filePath: string; body: Buffer }>,
): Buffer {
  const hexEntries = entries.map((e) => ({
    hexPath: Buffer.from(e.filePath, 'utf-8').toString('hex'),
    body: e.body,
  }));

  let totalSize = 4;
  for (const e of hexEntries) {
    totalSize += 2 + Buffer.byteLength(e.hexPath) + 4 + e.body.length;
  }

  const buf = Buffer.alloc(totalSize);
  let offset = 0;
  buf.writeUInt32LE(entries.length, offset);
  offset += 4;

  for (const e of hexEntries) {
    const pathBuf = Buffer.from(e.hexPath, 'utf-8');
    buf.writeUInt16LE(pathBuf.length, offset);
    offset += 2;
    pathBuf.copy(buf, offset);
    offset += pathBuf.length;
    buf.writeUInt32LE(e.body.length, offset);
    offset += 4;
    e.body.copy(buf, offset);
    offset += e.body.length;
  }

  return buf;
}

// --- Tests ---

let db: Database.Database;

beforeEach(() => {
  vi.resetAllMocks();
  db = createTestDb();
});

describe('handleBatchWrite', () => {
  it('returns 200 and forwards all entries to upstream on success', async () => {
    const charData = Buffer.from(JSON.stringify({ name: 'Alice', chaId: 'char-1' }));
    const payload = buildBatchPayload([
      { filePath: 'remotes/char-1.local.bin', body: charData },
      { filePath: 'remotes/char-2.local.bin', body: charData },
    ]);

    vi.mocked(bufferBody).mockResolvedValue(payload);
    vi.mocked(writeToUpstreamWithStatus).mockResolvedValue(200);

    const req = createMockReq({ 'risu-auth': 'test-token' });
    const holder = createMockRes();

    await handleBatchWrite(req, holder.res, db);

    // Both entries forwarded to upstream
    expect(writeToUpstreamWithStatus).toHaveBeenCalledTimes(2);

    // Response is 200
    expect(holder.statusCode).toBe(200);
    const body = JSON.parse(holder.responseBody);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);

    // file_list_cache updated
    const cached = db.prepare('SELECT path FROM file_list_cache ORDER BY path').all();
    expect(cached).toHaveLength(2);
  });

  it('returns 502 when any upstream write fails', async () => {
    const charData = Buffer.from(JSON.stringify({ name: 'Alice', chaId: 'char-1' }));
    const payload = buildBatchPayload([
      { filePath: 'remotes/char-1.local.bin', body: charData },
      { filePath: 'remotes/char-2.local.bin', body: charData },
    ]);

    vi.mocked(bufferBody).mockResolvedValue(payload);
    // First succeeds, second fails
    vi.mocked(writeToUpstreamWithStatus)
      .mockResolvedValueOnce(200)
      .mockResolvedValueOnce(502);

    const req = createMockReq({ 'risu-auth': 'test-token' });
    const holder = createMockRes();

    await handleBatchWrite(req, holder.res, db);

    expect(holder.statusCode).toBe(502);
    const body = JSON.parse(holder.responseBody);
    expect(body.ok).toBe(false);
    expect(body.failed).toBe(1);

    // file_list_cache NOT updated on failure
    const cached = db.prepare('SELECT path FROM file_list_cache').all();
    expect(cached).toHaveLength(0);
  });

  it('returns 200 for empty batch', async () => {
    const payload = buildBatchPayload([]);
    vi.mocked(bufferBody).mockResolvedValue(payload);

    const req = createMockReq();
    const holder = createMockRes();

    await handleBatchWrite(req, holder.res, db);

    expect(holder.statusCode).toBe(200);
    expect(writeToUpstreamWithStatus).not.toHaveBeenCalled();
  });

  it('handles mixed file types (remotes, database, meta)', async () => {
    const charData = Buffer.from(JSON.stringify({ name: 'Alice' }));
    const metaData = Buffer.from(JSON.stringify({ lastUsed: Date.now() }));
    const payload = buildBatchPayload([
      { filePath: 'database/database.bin', body: charData },
      { filePath: 'remotes/char-1.local.bin', body: charData },
      { filePath: 'remotes/char-1.local.bin.meta', body: metaData },
    ]);

    vi.mocked(bufferBody).mockResolvedValue(payload);
    vi.mocked(writeToUpstreamWithStatus).mockResolvedValue(200);

    const req = createMockReq({ 'risu-auth': 'test-token' });
    const holder = createMockRes();

    await handleBatchWrite(req, holder.res, db);

    // ALL entries forwarded to upstream
    expect(writeToUpstreamWithStatus).toHaveBeenCalledTimes(3);
    expect(holder.statusCode).toBe(200);

    // All paths in file_list_cache
    const cached = db.prepare('SELECT path FROM file_list_cache ORDER BY path').all();
    expect(cached).toHaveLength(3);
  });

  it('passes auth header to upstream', async () => {
    const charData = Buffer.from(JSON.stringify({ name: 'Alice' }));
    const payload = buildBatchPayload([
      { filePath: 'remotes/char-1.local.bin', body: charData },
    ]);

    vi.mocked(bufferBody).mockResolvedValue(payload);
    vi.mocked(writeToUpstreamWithStatus).mockResolvedValue(200);

    const req = createMockReq({ 'risu-auth': 'my-jwt-token' });
    const holder = createMockRes();

    await handleBatchWrite(req, holder.res, db);

    expect(writeToUpstreamWithStatus).toHaveBeenCalledWith(
      'remotes/char-1.local.bin',
      expect.any(Buffer),
      'my-jwt-token',
    );
  });
});
