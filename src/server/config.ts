export const PORT = parseInt(process.env.PORT || '3001', 10);
export const UPSTREAM = process.env.UPSTREAM || 'http://localhost:6001';
export const DB_PATH = process.env.DB_PATH || './data/proxy.db';
export const RECONCILE_INTERVAL_MS = parseInt(
  process.env.RECONCILE_INTERVAL_MS || '300000',
  10,
);
