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

import { DDL } from './schema';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(DDL);
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

  it('cleans cache entry on 2xx success', () => {
    addToFileListCache(db, 'database/dbbackup-123.bin');
    expect(getFileListCache(db)).toContain('database/dbbackup-123.bin');

    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-123.bin', db);

    const cb = getTeeCallback();
    cb(200, Buffer.from('{"success":true}'));

    expect(getFileListCache(db)).not.toContain('database/dbbackup-123.bin');
  });

  it('cleans cache entry on 500 without ENOENT in body', () => {
    addToFileListCache(db, 'database/dbbackup-123.bin');

    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-123.bin', db);

    const cb = getTeeCallback();
    cb(500, Buffer.from('Internal Server Error'));

    expect(getFileListCache(db)).not.toContain('database/dbbackup-123.bin');
  });

  it('cleans cache entry on 500 with ENOENT in body', () => {
    addToFileListCache(db, 'database/dbbackup-123.bin');

    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-123.bin', db);

    const cb = getTeeCallback();
    cb(500, Buffer.from('Error: ENOENT: no such file or directory, lstat \'/app/save/xxx\''));

    expect(getFileListCache(db)).not.toContain('database/dbbackup-123.bin');
  });

  it('cleans cache entry on 502', () => {
    addToFileListCache(db, 'database/dbbackup-123.bin');

    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-123.bin', db);

    const cb = getTeeCallback();
    cb(502, Buffer.from('Bad Gateway'));

    expect(getFileListCache(db)).not.toContain('database/dbbackup-123.bin');
  });

  it('is safe when entry is not in cache (no-op)', () => {
    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-999.bin', db);

    const cb = getTeeCallback();
    // Should not throw
    cb(500, Buffer.from('Internal Server Error'));

    expect(getFileListCache(db)).toHaveLength(0);
  });

  it('logs filePath and status on every remove', () => {
    handleRemoveFile(createMockReq(), createMockRes(), 'database/dbbackup-123.bin', db);

    const cb = getTeeCallback();
    cb(500, Buffer.from(''));

    expect(log.info).toHaveBeenCalledWith(
      'Remove forwarded, cleaning cache entry',
      expect.objectContaining({ filePath: 'database/dbbackup-123.bin', status: '500' }),
    );
  });
});
