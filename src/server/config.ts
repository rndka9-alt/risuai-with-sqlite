// --- Required env validation ---

if (!process.env.UPSTREAM) {
  throw new Error('UPSTREAM env is required (e.g. http://risuai:6001)');
}

const RISUAI_SAVE_MOUNT = '/risuai-save';

export const PORT = parseInt(process.env.PORT || '3001', 10);

const upstreamRaw = process.env.UPSTREAM;
const UPSTREAM_URL = new URL(upstreamRaw);
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

// Custom headers
export const FILE_PATH_HEADER = 'file-path';
export const REQUEST_ID_HEADER = 'x-request-id';
export const RISU_AUTH_HEADER = 'risu-auth';
export const DBPROXY_TARGET_HEADER = 'x-dbproxy-target-char';

/** Auth check를 건너뛰는 db- 라우트 타입 목록 (읽기 전용·캐시 워밍용) */
export const AUTH_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  'db-client-js',
  'db-batch-remotes',
  'db-file-list-dataset',
]);

// RisuAI save mount
export { RISUAI_SAVE_MOUNT };

// Circuit breaker
export const CB_FAILURE_THRESHOLD = parseInt(
  process.env.CB_FAILURE_THRESHOLD || '5',
  10,
);
export const CB_RESET_TIMEOUT_MS = parseInt(
  process.env.CB_RESET_TIMEOUT_MS || '30000',
  10,
);
