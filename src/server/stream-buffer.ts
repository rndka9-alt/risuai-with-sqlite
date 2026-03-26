import http from 'http';
import { UPSTREAM, DBPROXY_TARGET_HEADER } from './config';
import * as log from './logger';

/** POST /proxy2 → upstream 프록시 (SSE 스트리밍 투명 전달) */
export function handleProxy2(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const headers: Record<string, string | string[] | undefined> = {
    ...req.headers,
    host: UPSTREAM.host,
  };
  delete headers[DBPROXY_TARGET_HEADER];

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

  req.pipe(proxyReq);

  proxyReq.on('error', (err) => {
    log.error('proxy2 upstream error', { error: err.message });
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('Bad Gateway');
  });
}
