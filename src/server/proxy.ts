import http from 'http';
import { UPSTREAM } from './config';
import * as log from './logger';

/** Decode hex-encoded file-path header to UTF-8 string */
export function decodeFilePath(req: http.IncomingMessage): string | null {
  const raw = req.headers['file-path'];
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
  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode!, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  req.pipe(proxyReq);

  proxyReq.on('error', (err) => {
    log.error('Upstream error', { error: err.message });
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
  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode!, proxyRes.headers);

      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => {
        res.write(chunk);
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        res.end();
        const body = Buffer.concat(chunks);
        try {
          onBody(proxyRes.statusCode!, body);
        } catch (err) {
          log.error('Tee onBody error', { error: String(err) });
        }
      });
    },
  );

  req.pipe(proxyReq);

  proxyReq.on('error', (err) => {
    log.error('Upstream error', { error: err.message });
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
    'file-path': encodeFilePath(filePath),
    'content-type': 'application/octet-stream',
    'content-length': String(data.length),
  };
  if (authHeader) {
    headers['risu-auth'] = authHeader;
  }

  const proxyReq = http.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port,
    path: '/api/write',
    method: 'POST',
    headers,
  });

  proxyReq.end(data);

  proxyReq.on('error', (err) => {
    log.warn('Fire-and-forget write error', { filePath, error: err.message });
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
