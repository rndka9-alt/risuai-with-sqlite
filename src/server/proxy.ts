import http from 'http';
import { createReadStream } from 'fs';
import { readFile, access } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { UPSTREAM, FILE_PATH_HEADER, REQUEST_ID_HEADER, RISU_AUTH_HEADER, RISUAI_SAVE_MOUNT } from './config';
import * as log from './logger';

/** Decode hex-encoded file-path header to UTF-8 string */
export function decodeFilePath(req: http.IncomingMessage): string | null {
  const raw = req.headers[FILE_PATH_HEADER];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(raw)) return null;
  return Buffer.from(raw, 'hex').toString('utf-8');
}

/** Encode a UTF-8 string to hex for file-path header */
export function encodeFilePath(path: string): string {
  return Buffer.from(path, 'utf-8').toString('hex');
}

/** Forward a request transparently to upstream. Pipes body and response. */
export function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const t0 = performance.now();
  const rid = req.headers[REQUEST_ID_HEADER] || '';

  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (proxyRes) => {
      log.debug('upstream TTFB', { rid, url: req.url, ms: (performance.now() - t0).toFixed(0) });
      res.writeHead(proxyRes.statusCode!, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  req.pipe(proxyReq);

  proxyReq.on('error', (err) => {
    log.error('Upstream error', { rid, error: err.message });
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('Bad Gateway');
  });
}

/**
 * Forward a request to upstream, tee the response:
 * sends it to the client AND captures the body buffer.
 * onBody is called with the full buffered response once streaming completes.
 */
export function forwardAndTee(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  onBody: (statusCode: number, body: Buffer) => void,
): void {
  const t0 = performance.now();
  const rid = req.headers[REQUEST_ID_HEADER] || '';

  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (proxyRes) => {
      const ttfb = performance.now();
      log.debug('upstream TTFB', { rid, url: req.url, ms: (ttfb - t0).toFixed(0) });
      res.writeHead(proxyRes.statusCode!, proxyRes.headers);

      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => {
        res.write(chunk);
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        log.debug('upstream done', { rid, url: req.url, totalMs: (performance.now() - t0).toFixed(0), bodyKB: String((Buffer.concat(chunks).length / 1024).toFixed(0)) });
        res.end();
        const body = Buffer.concat(chunks);
        try {
          onBody(proxyRes.statusCode!, body);
        } catch (err) {
          log.error('Tee onBody error', { rid, error: String(err) });
        }
      });
    },
  );

  req.pipe(proxyReq);

  proxyReq.on('error', (err) => {
    log.error('Upstream error', { rid, error: err.message });
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('Bad Gateway');
  });
}

/**
 * Forward a pre-buffered body to upstream and pipe the response back.
 * Used in write path where body was already consumed for parsing.
 */
export function forwardBuffered(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
): void {
  const headers = { ...req.headers, host: UPSTREAM.host };
  headers['content-length'] = String(body.length);

  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: req.url,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode!, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.end(body);

  proxyReq.on('error', (err) => {
    log.error('Upstream error', { error: err.message });
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('Bad Gateway');
  });
}

/**
 * Fire-and-forget write to upstream.
 * Used for writing cold storage entries to FS for consistency.
 */
export function writeToUpstream(
  filePath: string,
  data: Buffer,
  authHeader: string | undefined,
): void {
  const headers: Record<string, string> = {
    host: UPSTREAM.host,
    [FILE_PATH_HEADER]: encodeFilePath(filePath),
    'content-type': 'application/octet-stream',
    'content-length': String(data.length),
  };
  if (authHeader) {
    headers[RISU_AUTH_HEADER] = authHeader;
  }

  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: '/api/write',
      method: 'POST',
      headers,
    },
    (proxyRes) => {
      proxyRes.resume();
    },
  );

  proxyReq.end(data);

  proxyReq.on('error', (err) => {
    log.warn('Fire-and-forget write error', { filePath, error: err.message });
  });
}

/**
 * Forward a request to upstream, buffer the response, transform it,
 * then send the transformed body to the client.
 * Used in hydration path where we want to slim data before serving.
 */
export function forwardBufferAndTransform(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  transform: (statusCode: number, headers: http.IncomingHttpHeaders, body: Buffer) => Promise<Buffer | null> | Buffer | null,
): void {
  const t0 = performance.now();
  const rid = req.headers[REQUEST_ID_HEADER] || '';

  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (proxyRes) => {
      const ttfb = performance.now();
      log.debug('upstream TTFB', { rid, url: req.url, ms: (ttfb - t0).toFixed(0) });

      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks);
        const upstreamMs = performance.now() - t0;
        log.debug('upstream done', { rid, url: req.url, upstreamMs: upstreamMs.toFixed(0), bodyKB: String((body.length / 1024).toFixed(0)) });

        const sendResponse = (transformed: Buffer | null): void => {
          const totalMs = performance.now() - t0;
          log.info('bufferAndTransform complete', { rid, url: req.url, upstreamMs: upstreamMs.toFixed(0), transformMs: (totalMs - upstreamMs).toFixed(0), totalMs: totalMs.toFixed(0) });
          const output = transformed ?? body;
          const headers = { ...proxyRes.headers };
          headers['content-length'] = String(output.length);
          delete headers['content-encoding'];
          res.writeHead(proxyRes.statusCode!, headers);
          res.end(output);
        };

        try {
          const result = transform(proxyRes.statusCode!, proxyRes.headers, body);
          if (result instanceof Promise) {
            result
              .then(sendResponse)
              .catch((err) => {
                log.error('Async transform error, sending original', { rid, error: String(err) });
                sendResponse(null);
              });
          } else {
            sendResponse(result);
          }
        } catch (err) {
          log.error('Transform error, sending original', { rid, error: String(err) });
          sendResponse(null);
        }
      });
    },
  );

  req.pipe(proxyReq);

  proxyReq.on('error', (err) => {
    log.error('Upstream error', { rid, error: err.message });
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('Bad Gateway');
  });
}

/** Fetch from upstream. Defaults to GET /api/read with file-path header.
 *  Pass overridePath (e.g. '/api/list') to hit a different endpoint. */
export function fetchFromUpstream(
  filePath: string,
  authHeader: string | undefined,
  overridePath?: string,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      host: UPSTREAM.host,
    };
    if (filePath) {
      headers[FILE_PATH_HEADER] = encodeFilePath(filePath);
    }
    if (authHeader) {
      headers[RISU_AUTH_HEADER] = authHeader;
    }

    const proxyReq = http.request(
      {
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port,
        path: overridePath || '/api/read',
        method: 'GET',
        headers,
      },
      (proxyRes) => {
        if (proxyRes.statusCode! < 200 || proxyRes.statusCode! >= 300) {
          proxyRes.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );

    proxyReq.on('error', (err) => {
      log.warn('fetchFromUpstream error', { filePath, error: err.message });
      resolve(null);
    });
    proxyReq.end();
  });
}

/** Buffer the full request body */
export function bufferBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Filesystem direct-read (via /risuai-save mount)
// ═══════════════════════════════════════════════════════════════════════════════

export function saveMountPath(filePath: string): string {
  return path.join(RISUAI_SAVE_MOUNT, encodeFilePath(filePath));
}

/** Check if a file exists on the save mount. */
export async function existsOnSaveMount(filePath: string): Promise<boolean> {
  try {
    await access(saveMountPath(filePath), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read a file from the save mount. Returns null if not found. */
export async function readFromSaveMount(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(saveMountPath(filePath));
  } catch {
    return null;
  }
}

/** Open a ReadStream from the save mount. Caller must handle errors. */
export function createSaveMountReadStream(filePath: string): ReturnType<typeof createReadStream> {
  return createReadStream(saveMountPath(filePath));
}

/** Stream-compute SHA-256 hash of a file on the save mount without buffering. */
export function hashFromSaveMount(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(saveMountPath(filePath));
    const hash = crypto.createHash('sha256');
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(null));
  });
}

