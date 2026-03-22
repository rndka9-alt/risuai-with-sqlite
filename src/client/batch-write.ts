/**
 * Client-side write coalescing for ALL POST /api/write requests.
 *
 * Every write gets an immediate synthetic 200 and is queued.
 * After 100ms of no new writes (debounce), the queue is flushed
 * as a single POST /db/batch-write.
 *
 * On batch failure: replays each write individually (original behavior).
 */

import { onFileWrite } from './file-list-dataset';

const DEBOUNCE_MS = 100;

interface QueuedWrite {
  hexPath: string;
  body: ArrayBuffer;
  authHeader: string;
}

let writeQueue: QueuedWrite[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Real (unpatched) fetch, set before fetch-patch installs */
let realFetch: typeof fetch;

function hexToUtf8(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Queue a write. Always returns an immediate synthetic 200.
 */
export function enqueueWrite(
  hexPath: string,
  init: RequestInit,
  authHeader: string,
): Response {
  let bodyBuf: ArrayBuffer;
  if (init.body instanceof ArrayBuffer) {
    bodyBuf = init.body;
  } else if (init.body instanceof Uint8Array) {
    bodyBuf = new Uint8Array(init.body).buffer;
  } else {
    bodyBuf = new ArrayBuffer(0);
  }

  writeQueue.push({ hexPath, body: bodyBuf, authHeader });

  // Reset debounce
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushQueue, DEBOUNCE_MS);

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Pack queued writes into the batch wire format. */
function serializeBatch(entries: QueuedWrite[]): ArrayBuffer {
  // [Uint32LE: count]
  // For each:
  //   [Uint16LE: hexPathLen] [UTF-8: hexPath]
  //   [Uint32LE: dataLen]    [bytes: body]

  const encoder = new TextEncoder();
  const encoded = entries.map((e) => ({
    pathBytes: encoder.encode(e.hexPath),
    bodyBytes: new Uint8Array(e.body),
  }));

  let totalSize = 4;
  for (const e of encoded) {
    totalSize += 2 + e.pathBytes.length + 4 + e.bodyBytes.length;
  }

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;

  view.setUint32(offset, entries.length, true);
  offset += 4;

  for (const e of encoded) {
    view.setUint16(offset, e.pathBytes.length, true);
    offset += 2;
    bytes.set(e.pathBytes, offset);
    offset += e.pathBytes.length;
    view.setUint32(offset, e.bodyBytes.length, true);
    offset += 4;
    bytes.set(e.bodyBytes, offset);
    offset += e.bodyBytes.length;
  }

  return buf;
}

/** Replay each write individually (fallback on batch failure). */
async function replayIndividually(entries: QueuedWrite[]): Promise<void> {
  for (const entry of entries) {
    try {
      await realFetch.call(window, '/api/write', {
        method: 'POST',
        body: entry.body,
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': entry.hexPath,
          'risu-auth': entry.authHeader,
        },
      });
    } catch (err) {
      console.error('[batch-write] replay failed', hexToUtf8(entry.hexPath), err);
    }
  }
}

async function flushQueue(): Promise<void> {
  flushTimer = null;
  const batch = writeQueue.splice(0);
  if (batch.length === 0) return;

  // Single write — forward directly, no batch overhead
  if (batch.length === 1) {
    try {
      const entry = batch[0];
      const resp = await realFetch.call(window, '/api/write', {
        method: 'POST',
        body: entry.body,
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': entry.hexPath,
          'risu-auth': entry.authHeader,
        },
      });
      if (resp.ok) onFileWrite(hexToUtf8(entry.hexPath));
    } catch (err) {
      console.error('[batch-write] single write failed', err);
    }
    return;
  }

  // Batch path
  try {
    const resp = await realFetch.call(window, '/db/batch-write', {
      method: 'POST',
      body: serializeBatch(batch),
      headers: {
        'content-type': 'application/octet-stream',
        'risu-auth': batch[0].authHeader,
      },
    });

    if (resp.ok) {
      for (const entry of batch) {
        onFileWrite(hexToUtf8(entry.hexPath));
      }
      return;
    }

    console.warn(`[batch-write] batch failed (${resp.status}), replaying individually`);
  } catch (err) {
    console.warn('[batch-write] batch error, replaying individually', err);
  }

  // Fallback: replay each write individually
  await replayIndividually(batch);
  for (const entry of batch) {
    onFileWrite(hexToUtf8(entry.hexPath));
  }
}

/**
 * Store a reference to the real (unpatched) fetch.
 * Must be called before fetch is monkey-patched.
 */
export function installBatchWrite(original: typeof fetch): void {
  realFetch = original;
}
