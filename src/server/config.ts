export const PORT = parseInt(process.env.PORT || '3001', 10);

const upstreamRaw = process.env.UPSTREAM || 'http://localhost:6001';
export const UPSTREAM_URL = new URL(upstreamRaw);
export const UPSTREAM = {
  hostname: UPSTREAM_URL.hostname,
  port: parseInt(UPSTREAM_URL.port || (UPSTREAM_URL.protocol === 'https:' ? '443' : '80'), 10),
  host: UPSTREAM_URL.host,
  protocol: UPSTREAM_URL.protocol,
};

export const DB_PATH = process.env.DB_PATH || './data/proxy.db';

// Logging
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

/** 프록시 모듈 간 공유하는 클라이언트 식별 헤더 */
export const CLIENT_ID_HEADER = 'x-proxy-client-id';

// Circuit breaker
export const CB_FAILURE_THRESHOLD = parseInt(
  process.env.CB_FAILURE_THRESHOLD || '5',
  10,
);
export const CB_RESET_TIMEOUT_MS = parseInt(
  process.env.CB_RESET_TIMEOUT_MS || '30000',
  10,
);
