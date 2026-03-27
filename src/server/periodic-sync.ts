/**
 * Periodic data sync with risuai.
 *
 * Runs once every 24 hours. Fetches fresh data from risuai via API,
 * compares with SQLite cache, corrects drift, and logs inconsistencies.
 */

import type Database from 'better-sqlite3';
import { fetchFromUpstream, readFromSaveMount } from './proxy';
import { populateFileListCache, getFileListCache, upsertMetaLastUsed, getMetaEntries, getMetaMissingLastUsed } from './db';
import { reconcileDatabaseBin, reconcileRemoteFile } from './reconcile';
import { parseRisuSave, parseRemotePointer } from './parser';
import { issueInternalToken, isAuthReady } from './auth';
import { RisuSaveType } from '../shared/types';
import * as log from './logger';

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REACTIVE_SYNC_COOLDOWN_MS = 60_000; // 1 minute
const SYNC_CONCURRENCY = 10;

let timer: ReturnType<typeof setInterval> | null = null;
let lastReactiveSync = 0;

export function startPeriodicSync(getDb: () => Database.Database): void {
  timer = setInterval(() => {
    runSync(getDb).catch((err) =>
      log.error('Periodic sync failed', { error: String(err) }),
    );
  }, SYNC_INTERVAL_MS);

  log.info('Periodic sync scheduled', { intervalHours: 24 });
}

export interface SyncResult {
  filesAdded: number;
  filesRemoved: number;
  metaUpdated: number;
  dbBinDrift: boolean;
  remotesUpdated: number;
  elapsedMs: number;
  skipped?: string;
}

export async function runSync(getDb: () => Database.Database): Promise<SyncResult> {
  if (!isAuthReady()) {
    log.warn('Periodic sync skipped — auth not ready');
    return { filesAdded: 0, filesRemoved: 0, metaUpdated: 0, dbBinDrift: false, remotesUpdated: 0, elapsedMs: 0, skipped: 'auth not ready' };
  }

  const token = await issueInternalToken();
  if (!token) {
    log.warn('Periodic sync skipped — cannot issue token');
    return { filesAdded: 0, filesRemoved: 0, metaUpdated: 0, dbBinDrift: false, remotesUpdated: 0, elapsedMs: 0, skipped: 'cannot issue token' };
  }

  const db = getDb();
  const t0 = performance.now();
  log.info('Periodic sync started');

  // 1. File list reconciliation
  const fileListDrift = await syncFileList(db, token);

  // 2. .meta lastUsed sync
  const metaDrift = await syncMeta(db, token);

  // 3. database.bin reconciliation (결과를 syncRemotes에서 재사용)
  const { drifted: dbDrift, body: dbBinBody } = await syncDatabaseBin(db, token);

  // 4. Remote character reconciliation
  const remoteDrift = await syncRemotes(db, token, dbBinBody);

  const elapsed = Math.round(performance.now() - t0);
  const hasDrift = fileListDrift.added > 0 || fileListDrift.removed > 0
    || metaDrift > 0 || dbDrift || remoteDrift > 0;

  const result: SyncResult = {
    filesAdded: fileListDrift.added,
    filesRemoved: fileListDrift.removed,
    metaUpdated: metaDrift,
    dbBinDrift: dbDrift,
    remotesUpdated: remoteDrift,
    elapsedMs: elapsed,
  };

  if (hasDrift) {
    log.warn('Periodic sync found drift', {
      ms: String(elapsed),
      filesAdded: fileListDrift.added,
      filesRemoved: fileListDrift.removed,
      metaUpdated: metaDrift,
      dbBinDrift: dbDrift,
      remotesUpdated: remoteDrift,
    });
  } else {
    log.info('Periodic sync complete — no drift', { ms: String(elapsed) });
  }

  return result;
}

async function syncFileList(
  db: Database.Database,
  token: string,
): Promise<{ added: number; removed: number }> {
  const body = await fetchFromUpstream('', token, '/api/list');
  if (!body || body.length === 0) return { added: 0, removed: 0 };

  try {
    const data: { content?: string[] } = JSON.parse(body.toString('utf-8'));
    if (!data.content || !Array.isArray(data.content)) return { added: 0, removed: 0 };

    const upstream = new Set(data.content);
    const cached = new Set(getFileListCache(db));

    const added = [...upstream].filter((f) => !cached.has(f)).length;
    const removed = [...cached].filter((f) => !upstream.has(f)).length;

    if (added > 0 || removed > 0) {
      populateFileListCache(db, data.content);
      log.warn('File list drift detected', { added, removed });
    }

    return { added, removed };
  } catch {
    return { added: 0, removed: 0 };
  }
}

async function syncMeta(
  db: Database.Database,
  token: string,
): Promise<number> {
  const entries = getMetaEntries(db);
  let updated = 0;

  for (let i = 0; i < entries.length; i += SYNC_CONCURRENCY) {
    const batch = entries.slice(i, i + SYNC_CONCURRENCY);
    await Promise.all(batch.map(async (entry) => {
      try {
        const body = await fetchFromUpstream(entry.path, token);
        if (!body || body.length === 0) return;
        const parsed: { lastUsed?: number } = JSON.parse(body.toString('utf-8'));
        if (typeof parsed.lastUsed === 'number' && parsed.lastUsed !== entry.lastUsed) {
          upsertMetaLastUsed(db, entry.path, parsed.lastUsed);
          updated++;
        }
      } catch { /* skip */ }
    }));
  }

  const missing = getMetaMissingLastUsed(db);
  for (let i = 0; i < missing.length; i += SYNC_CONCURRENCY) {
    const batch = missing.slice(i, i + SYNC_CONCURRENCY);
    await Promise.all(batch.map(async (metaPath) => {
      try {
        const body = await fetchFromUpstream(metaPath, token);
        if (!body || body.length === 0) return;
        const parsed: { lastUsed?: number } = JSON.parse(body.toString('utf-8'));
        if (typeof parsed.lastUsed === 'number') {
          upsertMetaLastUsed(db, metaPath, parsed.lastUsed);
          updated++;
        }
      } catch { /* skip */ }
    }));
  }

  if (updated > 0) {
    log.warn('.meta drift detected', { updated });
  }
  return updated;
}

async function syncDatabaseBin(
  db: Database.Database,
  token: string,
): Promise<{ drifted: boolean; body: Buffer | null }> {
  const body = await readFromSaveMount('database/database.bin')
    ?? await fetchFromUpstream('database/database.bin', token);
  if (!body || body.length === 0) return { drifted: false, body: null };
  const drifted = reconcileDatabaseBin(db, Buffer.from(body));
  return { drifted, body };
}

async function syncRemotes(
  db: Database.Database,
  token: string,
  dbBinBody: Buffer | null,
): Promise<number> {
  // syncDatabaseBin에서 이미 fetch한 결과를 재사용
  const buf = dbBinBody ?? await fetchFromUpstream('database/database.bin', token);
  if (!buf || buf.length === 0) return 0;

  const result = parseRisuSave(Buffer.from(buf));
  if (!result) return 0;

  const charIds: string[] = [];
  for (const block of result.blocks) {
    if (block.type === RisuSaveType.REMOTE) {
      const ptr = parseRemotePointer(block.data);
      if (ptr) charIds.push(ptr.charId);
    }
  }

  let updated = 0;
  for (const charId of charIds) {
    try {
      const filePath = `remotes/${charId}.local.bin`;
      const body = await readFromSaveMount(filePath)
        ?? await fetchFromUpstream(filePath, token);
      if (!body || body.length === 0) continue;
      const drifted = await reconcileRemoteFile(db, Buffer.from(body), charId, token);
      if (drifted) updated++;
    } catch { /* skip */ }
  }

  if (updated > 0) {
    log.warn('Remote character drift detected', { updated, total: charIds.length });
  }
  return updated;
}

/**
 * Trigger file list reconciliation reactively (e.g. on remove 500).
 *
 * Debounced to 1 minute to avoid hammering upstream when multiple
 * stale entries trigger sequential remove failures.
 */
export function requestFileListReconciliation(db: Database.Database): void {
  const now = Date.now();
  if (now - lastReactiveSync < REACTIVE_SYNC_COOLDOWN_MS) return;
  lastReactiveSync = now;

  log.info('Reactive file list reconciliation triggered');

  (async () => {
    if (!isAuthReady()) return;
    const token = await issueInternalToken();
    if (!token) return;
    const drift = await syncFileList(db, token);
    if (drift.added > 0 || drift.removed > 0) {
      log.warn('Reactive reconciliation found drift', {
        added: drift.added,
        removed: drift.removed,
      });
    }
  })().catch((err) => {
    log.warn('Reactive file list reconciliation failed', { error: String(err) });
  });
}
