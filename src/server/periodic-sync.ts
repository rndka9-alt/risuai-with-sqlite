/**
 * Periodic data sync with risuai.
 *
 * Runs once every 24 hours. Fetches fresh data from risuai via API,
 * compares with SQLite cache, corrects drift, and logs inconsistencies.
 */

import type Database from 'better-sqlite3';
import { fetchFromUpstream } from './proxy';
import { populateFileListCache, getFileListCache, upsertMetaLastUsed, getMetaEntries, getMetaMissingLastUsed } from './db';
import { reconcileDatabaseBin, reconcileRemoteFile } from './reconcile';
import { parseRisuSave, parseRemotePointer } from './parser';
import { issueInternalToken, isAuthReady } from './auth';
import { RisuSaveType } from '../shared/types';
import * as log from './logger';

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let timer: ReturnType<typeof setInterval> | null = null;

export function startPeriodicSync(getDb: () => Database.Database): void {
  timer = setInterval(() => {
    runSync(getDb).catch((err) =>
      log.error('Periodic sync failed', { error: String(err) }),
    );
  }, SYNC_INTERVAL_MS);

  log.info('Periodic sync scheduled', { intervalHours: 24 });
}

async function runSync(getDb: () => Database.Database): Promise<void> {
  if (!isAuthReady()) {
    log.warn('Periodic sync skipped — auth not ready');
    return;
  }

  const token = await issueInternalToken();
  if (!token) {
    log.warn('Periodic sync skipped — cannot issue token');
    return;
  }

  const db = getDb();
  const t0 = performance.now();
  log.info('Periodic sync started');

  // 1. File list reconciliation
  const fileListDrift = await syncFileList(db, token);

  // 2. .meta lastUsed sync
  const metaDrift = await syncMeta(db, token);

  // 3. database.bin reconciliation
  const dbDrift = await syncDatabaseBin(db, token);

  // 4. Remote character reconciliation
  const remoteDrift = await syncRemotes(db, token);

  const ms = (performance.now() - t0).toFixed(0);
  const hasDrift = fileListDrift.added > 0 || fileListDrift.removed > 0
    || metaDrift > 0 || dbDrift || remoteDrift > 0;

  if (hasDrift) {
    log.warn('Periodic sync found drift', {
      ms,
      filesAdded: fileListDrift.added,
      filesRemoved: fileListDrift.removed,
      metaUpdated: metaDrift,
      dbBinDrift: dbDrift,
      remotesUpdated: remoteDrift,
    });
  } else {
    log.info('Periodic sync complete — no drift', { ms });
  }
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
  // Re-read all .meta files to catch stale lastUsed values
  const entries = getMetaEntries(db);
  let updated = 0;

  await Promise.all(entries.map(async (entry) => {
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

  // Also pick up any new .meta files
  const missing = getMetaMissingLastUsed(db);
  await Promise.all(missing.map(async (metaPath) => {
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

  if (updated > 0) {
    log.warn('.meta drift detected', { updated });
  }
  return updated;
}

async function syncDatabaseBin(
  db: Database.Database,
  token: string,
): Promise<boolean> {
  const body = await fetchFromUpstream('database/database.bin', token);
  if (!body || body.length === 0) return false;
  return reconcileDatabaseBin(db, Buffer.from(body));
}

async function syncRemotes(
  db: Database.Database,
  token: string,
): Promise<number> {
  // Get current character list from database.bin blocks
  const dbBody = await fetchFromUpstream('database/database.bin', token);
  if (!dbBody || dbBody.length === 0) return 0;

  const result = parseRisuSave(Buffer.from(dbBody));
  if (!result) return 0;

  const charIds: string[] = [];
  for (const block of result.blocks) {
    if (block.type === RisuSaveType.REMOTE) {
      const ptr = parseRemotePointer(block.data);
      if (ptr) charIds.push(ptr.charId);
    }
  }

  let updated = 0;
  await Promise.all(charIds.map(async (charId) => {
    try {
      const body = await fetchFromUpstream(`remotes/${charId}.local.bin`, token);
      if (!body || body.length === 0) return;
      const drifted = await reconcileRemoteFile(db, Buffer.from(body), charId, token);
      if (drifted) updated++;
    } catch { /* skip */ }
  }));

  if (updated > 0) {
    log.warn('Remote character drift detected', { updated, total: charIds.length });
  }
  return updated;
}
