export const PORT = parseInt(process.env.PORT || '3001', 10);
export const UPSTREAM = process.env.UPSTREAM || 'http://localhost:6001';
export const DB_PATH = process.env.DB_PATH || './data/proxy.db';
export const RECONCILE_INTERVAL_MS = parseInt(
  process.env.RECONCILE_INTERVAL_MS || '300000',
  10,
);

// Circuit breaker
export const CB_FAILURE_THRESHOLD = parseInt(
  process.env.CB_FAILURE_THRESHOLD || '5',
  10,
);
export const CB_RESET_TIMEOUT_MS = parseInt(
  process.env.CB_RESET_TIMEOUT_MS || '30000',
  10,
);
