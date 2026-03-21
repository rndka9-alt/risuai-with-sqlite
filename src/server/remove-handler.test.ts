import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import Database from 'better-sqlite3';
import { handleRemoveFile } from './remove-handler';
import { addToFileListCache, getFileListCache } from './db';

vi.mock('./proxy', () => ({
  forwardRequest: vi.fn(),
  forwardAndTee: vi.fn(),
}));

vi.mock('./logger', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { forwardAndTee } from './proxy';
import * as log from './logger';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
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

function createMockRes(): http.ServerResponse {
  // @ts-expect-error test mock — not accessed directly (forwardAndTee is mocked)
  return {};
}

type TeeCallback = (statusCode: number, body: Buffer) => void;

function getTeeCallback(): TeeCallback {
  const calls = vi.mocked(forwardAndTee).mock.calls;
  const cb = calls[0]?.[2];
  if (!cb) throw new Error('forwardAndTee was not called');
  return cb;
}

let db: Database.Database;

beforeEach(() => {
  vi.resetAllMocks();
  db = createTestDb();
});

describe('handleRemoveFile', () => {
  it('calls forwardAndTee to proxy the request', () => {
    const req = createMockReq();
    const res = createMockRes();

    handleRemoveFile(req, res, 'database/dbbackup-123.bin', db);

    expect(forwardAndTee).toHaveBeenCalledWith(req, res, expect.any(Function));
  });

  it('removes ghost entry from cache when upstream returns 500 + ENOENT', () => {
    addToFileListCache(db, 'database/dbbackup-123.bin');
    expect(getFileListCache(db)).toContain('database/dbbackup-123.bin');

    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-123.bin', db);

    const cb = getTeeCallback();
    cb(500, Buffer.from('Error: ENOENT: no such file or directory, lstat \'/app/save/xxx\''));

    expect(getFileListCache(db)).not.toContain('database/dbbackup-123.bin');
    expect(log.info).toHaveBeenCalledWith(
      'Remove got ENOENT from upstream, cleaning ghost cache entry',
      expect.objectContaining({ filePath: 'database/dbbackup-123.bin' }),
    );
  });

  it('does NOT remove from cache when upstream returns 500 without ENOENT', () => {
    addToFileListCache(db, 'database/dbbackup-123.bin');

    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-123.bin', db);

    const cb = getTeeCallback();
    cb(500, Buffer.from('Internal Server Error: disk full'));

    expect(getFileListCache(db)).toContain('database/dbbackup-123.bin');
  });

  it('does NOT remove from cache when upstream returns 502', () => {
    addToFileListCache(db, 'database/dbbackup-123.bin');

    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-123.bin', db);

    const cb = getTeeCallback();
    cb(502, Buffer.from('Bad Gateway'));

    expect(getFileListCache(db)).toContain('database/dbbackup-123.bin');
  });

  it('does NOT call removeFromFileListCache on 2xx (handled by index.ts finish handler)', () => {
    addToFileListCache(db, 'database/dbbackup-123.bin');

    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-123.bin', db);

    const cb = getTeeCallback();
    cb(200, Buffer.from('{"success":true}'));

    // Entry still in cache — the finish handler in index.ts handles this case
    expect(getFileListCache(db)).toContain('database/dbbackup-123.bin');
  });

  it('handles ENOENT in HTML error body (Express development mode)', () => {
    addToFileListCache(db, 'remotes/abc.local.bin.meta');

    handleRemoveFile(createMockReq(), createMockRes(), 'remotes/abc.local.bin.meta', db);

    const cb = getTeeCallback();
    cb(500, Buffer.from('<html><pre>Error: ENOENT: no such file or directory</pre></html>'));

    expect(getFileListCache(db)).not.toContain('remotes/abc.local.bin.meta');
  });

  it('is safe when entry is not in cache (no-op)', () => {
    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-999.bin', db);

    const cb = getTeeCallback();
    // Should not throw
    cb(500, Buffer.from('ENOENT: no such file or directory'));

    expect(getFileListCache(db)).toHaveLength(0);
  });
});
