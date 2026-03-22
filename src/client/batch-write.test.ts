import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueueWrite, installBatchWrite } from './batch-write';

function utf8ToHex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// globalThis.window가 없으면 flush에서 realFetch.call(window, ...) 실패.
// 브라우저 환경 stub.
const stubWindow = {} as typeof globalThis;
vi.stubGlobal('window', stubWindow);

const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  installBatchWrite(mockFetch as unknown as typeof fetch);
});

describe('enqueueWrite — backup drop', () => {
  it('drops dbbackup-*.bin writes and returns synthetic 200', async () => {
    const hexPath = utf8ToHex('database/dbbackup-17741672869.bin');

    const response = enqueueWrite(hexPath, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
      headers: { 'content-type': 'application/octet-stream' },
    }, 'test-auth');

    expect(response.status).toBe(200);

    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('drops dbbackup with any timestamp suffix', async () => {
    const hexPath = utf8ToHex('database/dbbackup-99999999999.bin');

    const response = enqueueWrite(hexPath, {
      method: 'POST',
      body: new Uint8Array([0]),
      headers: {},
    }, 'auth');

    expect(response.status).toBe(200);
    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT drop database.bin writes — queued and flushed', async () => {
    const hexPath = utf8ToHex('database/database.bin');

    enqueueWrite(hexPath, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3, 4]),
      headers: {},
    }, 'auth');

    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('does NOT drop remote file writes — queued and flushed', async () => {
    const hexPath = utf8ToHex('remotes/char-1.local.bin');

    enqueueWrite(hexPath, {
      method: 'POST',
      body: new Uint8Array([5, 6]),
      headers: {},
    }, 'auth');

    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('does NOT drop asset writes — queued and flushed', async () => {
    const hexPath = utf8ToHex('assets/abc123.png');

    enqueueWrite(hexPath, {
      method: 'POST',
      body: new Uint8Array([7, 8]),
      headers: {},
    }, 'auth');

    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch).toHaveBeenCalled();
  });
});
