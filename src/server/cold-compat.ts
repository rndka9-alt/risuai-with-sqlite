import zlib from 'zlib';

/**
 * Compress a cold storage payload (JSON string → gzip bytes).
 * Compatible with fflate.decompress() on the client side.
 *
 * fflate.decompress() auto-detects gzip/zlib/raw-deflate,
 * so gzip is a safe choice from Node.js.
 */
export function compressColdStorage(jsonStr: string): Buffer {
  return zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'));
}

/**
 * Decompress a cold storage payload.
 * Handles gzip (from our proxy) and raw deflate (from fflate.compress).
 */
export function decompressColdStorage(data: Buffer): string {
  // Check magic bytes to determine format
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    // gzip
    return zlib.gunzipSync(data).toString('utf-8');
  }
  if (data.length >= 1 && data[0] === 0x78) {
    // zlib
    return zlib.inflateSync(data).toString('utf-8');
  }
  // raw deflate (fflate.compress default)
  return zlib.inflateRawSync(data).toString('utf-8');
}
