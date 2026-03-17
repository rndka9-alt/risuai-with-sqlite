import zlib from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const inflateRawAsync = promisify(zlib.inflateRaw);

/**
 * Compress a cold storage payload (JSON string → gzip bytes).
 * Compatible with fflate.decompress() on the client side.
 *
 * fflate.decompress() auto-detects gzip/zlib/raw-deflate,
 * so gzip is a safe choice from Node.js.
 *
 * Uses async zlib to avoid blocking the event loop during hydration.
 */
export async function compressColdStorage(jsonStr: string): Promise<Buffer> {
  return gzipAsync(Buffer.from(jsonStr, 'utf-8'));
}

/**
 * Decompress a cold storage payload.
 * Handles gzip (from our proxy) and raw deflate (from fflate.compress).
 *
 * Uses async zlib to avoid blocking the event loop.
 */
export async function decompressColdStorage(data: Buffer): Promise<string> {
  // Check magic bytes to determine format
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    // gzip
    return (await gunzipAsync(data)).toString('utf-8');
  }
  if (data.length >= 1 && data[0] === 0x78) {
    // zlib
    return (await inflateAsync(data)).toString('utf-8');
  }
  // raw deflate (fflate.compress default)
  return (await inflateRawAsync(data)).toString('utf-8');
}
