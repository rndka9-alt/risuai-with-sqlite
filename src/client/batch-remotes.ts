/**
 * Batch remote prefetch.
 *
 * Fetches all cached remote character data in a single request
 * from GET /db/batch-remotes. Individual /api/read requests for
 * remote files are then served from this prefetched cache.
 */

export function utf8ToHex(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// Cache: hex-encoded file-path -> ArrayBuffer
let batchCache: Map<string, ArrayBuffer> | null = null;
let batchPromise: Promise<void> | null = null;
let batchFailed = false;

const BATCH_TIMEOUT = 60_000;

function parseBatchResponse(buf: ArrayBuffer): Map<string, ArrayBuffer> {
  const view = new DataView(buf);
  const map = new Map<string, ArrayBuffer>();

  if (buf.byteLength < 4) return map;

  let offset = 0;
  const count = view.getUint32(offset, true); offset += 4;

  for (let i = 0; i < count; i++) {
    if (offset >= buf.byteLength) break;

    const charIdLen = view.getUint8(offset); offset += 1;
    const charIdBytes = new Uint8Array(buf, offset, charIdLen);
    const charId = new TextDecoder().decode(charIdBytes);
    offset += charIdLen;

    const dataLen = view.getUint32(offset, true); offset += 4;
    const data = buf.slice(offset, offset + dataLen);
    offset += dataLen;

    const hexPath = utf8ToHex(`remotes/${charId}.local.bin`);
    map.set(hexPath, data);
  }

  return map;
}

export function installBatchRemotes(): void {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BATCH_TIMEOUT);

  batchPromise = fetch('/db/batch-remotes', { signal: controller.signal })
    .then((resp) => {
      clearTimeout(timeout);
      if (resp.status === 204 || !resp.ok) {
        batchFailed = true;
        return;
      }
      return resp.arrayBuffer().then((buf) => {
        batchCache = parseBatchResponse(buf);
      });
    })
    .catch(() => {
      clearTimeout(timeout);
      batchFailed = true;
    });
}

/**
 * Try to serve a remote file read from the batch cache.
 *
 * Returns a Promise<Response> if the batch can handle this request,
 * or null if it should fall through to the original fetch.
 */
export function tryServeBatchRemote(hexFilePath: string): Promise<Response | null> | null {
  if (batchFailed) return null;

  // Batch already loaded
  if (batchCache) {
    const data = batchCache.get(hexFilePath);
    if (data) {
      return Promise.resolve(new Response(data, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }));
    }
    return null; // cache miss
  }

  // Batch still loading
  if (batchPromise) {
    return batchPromise.then(() => {
      if (batchFailed || !batchCache) {
        return null;
      }
      const data = batchCache.get(hexFilePath);
      if (data) {
        return new Response(data, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return null;
    });
  }

  return null;
}
