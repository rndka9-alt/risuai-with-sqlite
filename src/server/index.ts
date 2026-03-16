import http from 'http';
import { PORT, UPSTREAM } from './config';
import { forwardRequest, forwardAndTee, decodeFilePath } from './proxy';
import { createCircuitBreaker } from './circuit-breaker';
import { initDb, isDbReady, getDb, getBlock, getBlocksBySource, upsertBlock, upsertChat, getChat, inTransaction } from './db';
import { parseRisuSave, parseRemoteFile, parseRemotePointer } from './parser';
import { assembleRisuSave } from './assembler';
import { slimCharacter } from './slim';
import { writeToUpstream } from './proxy';
import { handleWriteDatabase, handleWriteRemote } from './write-handler';
import { reconcileDatabaseBin, reconcileRemoteFile } from './reconcile';
import { RisuSaveType, type HydrationState } from '../shared/types';

// --- Route classification ---

const REMOTE_FILE_RE = /^remotes\/(.+)\.local\.bin$/;
const COLDSTORAGE_RE = /^coldstorage\/(.+)$/;
const DATABASE_BIN = 'database/database.bin';

type Route =
  | { type: 'read-database' }
  | { type: 'read-remote'; charId: string }
  | { type: 'read-coldstorage'; key: string }
  | { type: 'write-database' }
  | { type: 'write-remote'; charId: string }
  | { type: 'passthrough' };

function classifyRequest(req: http.IncomingMessage): Route {
  if (req.url !== '/api/read' && req.url !== '/api/write') {
    return { type: 'passthrough' };
  }

  const filePath = decodeFilePath(req);
  if (!filePath) return { type: 'passthrough' };

  const isRead = req.method === 'GET';
  const isWrite = req.method === 'POST';

  if (filePath === DATABASE_BIN) {
    if (isRead) return { type: 'read-database' };
    if (isWrite) return { type: 'write-database' };
  }

  const remoteMatch = filePath.match(REMOTE_FILE_RE);
  if (remoteMatch) {
    if (isRead) return { type: 'read-remote', charId: remoteMatch[1] };
    if (isWrite) return { type: 'write-remote', charId: remoteMatch[1] };
  }

  const coldMatch = filePath.match(COLDSTORAGE_RE);
  if (coldMatch && isRead) {
    return { type: 'read-coldstorage', key: coldMatch[1] };
  }

  return { type: 'passthrough' };
}

// --- Hydration state ---

let hydrationState: HydrationState = 'COLD';
const capturedRemotes = new Set<string>();
let expectedRemoteCount = 0;

function checkHydrationComplete(): void {
  if (hydrationState === 'HOT') return;
  if (hydrationState === 'COLD') return;

  if (capturedRemotes.size >= expectedRemoteCount) {
    hydrationState = 'HOT';
    console.log(`[DB-Proxy] Hydration complete. State: HOT (${capturedRemotes.size} remotes cached)`);
  }
}

/**
 * Capture database.bin from upstream response and populate SQLite.
 * Called via tee pattern on the first client read.
 */
function captureDatabaseBin(body: Buffer, authHeader: string | undefined): void {
  if (!isDbReady()) return;
  const db = getDb();

  const result = parseRisuSave(body);
  if (!result) {
    console.error('[DB-Proxy] Failed to parse database.bin for hydration');
    return;
  }

  inTransaction(db, () => {
    for (const block of result.blocks) {
      upsertBlock(db, block.name, block.type, 'database.bin', block.compression, block.data, block.hash);

      // Track REMOTE pointers to know how many remotes to expect
      if (block.type === RisuSaveType.REMOTE) {
        const ptr = parseRemotePointer(block.data);
        if (ptr) expectedRemoteCount++;
      }
    }
  });

  hydrationState = 'WARMING';
  console.log(
    `[DB-Proxy] database.bin captured: ${result.blocks.length} blocks, ` +
      `${expectedRemoteCount} remotes expected. State: WARMING`,
  );

  checkHydrationComplete();
}

/**
 * Capture a remote character file and slim it for future reads.
 * Cold storage entries are written to upstream for FS consistency.
 */
function captureRemoteFile(
  body: Buffer,
  charId: string,
  authHeader: string | undefined,
): void {
  if (!isDbReady()) return;
  const db = getDb();

  const block = parseRemoteFile(body, charId);
  if (!block) return;

  const charJson = block.data.toString('utf-8');
  const { slimJson, coldEntries } = slimCharacter(charJson, charId);
  const slimBuffer = Buffer.from(slimJson, 'utf-8');

  inTransaction(db, () => {
    // Store slim character data
    upsertBlock(
      db,
      `remote:${charId}`,
      RisuSaveType.CHARACTER_WITH_CHAT,
      `remote:${charId}`,
      0,
      slimBuffer,
      block.hash,
    );

    // Store cold entries
    for (const entry of coldEntries) {
      upsertChat(db, entry.uuid, entry.charId, entry.chatIndex, entry.compressed, entry.hash);
    }
  });

  // Write cold storage to upstream for FS self-consistency (fire-and-forget)
  for (const entry of coldEntries) {
    writeToUpstream(`coldstorage/${entry.uuid}`, entry.compressed, authHeader);
  }

  capturedRemotes.add(charId);
  checkHydrationComplete();
}

// --- Read handlers ---

function handleReadDatabase(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const db = getDb();

  // In Node server mode, database.bin only has CONFIG/ROOT/BOTPRESET/MODULES/REMOTE blocks.
  // These are small. We reassemble from SQLite as-is (no slim needed for database.bin).
  const rows = getBlocksBySource(db, 'database.bin');

  if (rows.length === 0) {
    // No data yet — bypass
    throw new Error('No database.bin blocks in cache');
  }

  const binary = assembleRisuSave(
    rows.map((r) => ({
      name: r.name,
      type: r.type as RisuSaveType,
      data: r.data,
      compress: r.compression === 1,
    })),
  );

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(binary.length),
  });
  res.end(binary);
}

function handleReadRemote(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  charId: string,
): void {
  const db = getDb();

  const block = getBlock(db, `remote:${charId}`);
  if (!block) {
    throw new Error(`Remote ${charId} not in cache`);
  }

  // block.data is the slim character JSON
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(block.data.length),
  });
  res.end(block.data);
}

function handleReadColdStorage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  key: string,
): void {
  const db = getDb();

  const chat = getChat(db, key);
  if (!chat) {
    throw new Error(`Cold storage ${key} not in cache`);
  }

  // chat.data is already gzip-compressed (fflate-compatible)
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(chat.data.length),
  });
  res.end(chat.data);
}

// --- Server ---

const cb = createCircuitBreaker();

function main(): void {
  // Initialize SQLite (best-effort; if it fails, we run in pure proxy mode)
  try {
    initDb();
    console.log('[DB-Proxy] SQLite initialized');
  } catch (err) {
    console.error('[DB-Proxy] SQLite init failed, running in pure proxy mode:', err);
  }

  const server = http.createServer((req, res) => {
    const route = classifyRequest(req);

    switch (route.type) {
      case 'read-database': {
        const canAccelerate = isDbReady() && hydrationState !== 'COLD' && cb.allowRequest();
        if (canAccelerate) {
          try {
            handleReadDatabase(req, res);
            cb.onSuccess();
            return;
          } catch (err) {
            cb.onFailure();
            console.error('[DB-Proxy] read-database fallback:', (err as Error).message);
          }
        }
        // Bypass: tee for hydration or reconciliation
        const dbAuthHeader = typeof req.headers['risu-auth'] === 'string'
          ? req.headers['risu-auth']
          : undefined;
        forwardAndTee(req, res, (status, body) => {
          if (status < 200 || status >= 300 || body.length === 0 || !isDbReady()) return;
          try {
            if (hydrationState === 'HOT') {
              reconcileDatabaseBin(getDb(), body);
            } else {
              captureDatabaseBin(body, dbAuthHeader);
            }
          } catch (e) {
            console.error('[DB-Proxy] capture/reconcile database.bin error:', e);
          }
        });
        return;
      }

      case 'read-remote': {
        const canAccelerate = isDbReady() && hydrationState === 'HOT' && cb.allowRequest();
        if (canAccelerate) {
          try {
            handleReadRemote(req, res, route.charId);
            cb.onSuccess();
            return;
          } catch (err) {
            cb.onFailure();
            console.error('[DB-Proxy] read-remote fallback:', (err as Error).message);
          }
        }
        // Bypass: tee for hydration or reconciliation
        const remoteAuthHeader = typeof req.headers['risu-auth'] === 'string'
          ? req.headers['risu-auth']
          : undefined;
        forwardAndTee(req, res, (status, body) => {
          if (status < 200 || status >= 300 || body.length === 0 || !isDbReady()) return;
          try {
            if (hydrationState === 'HOT') {
              reconcileRemoteFile(getDb(), body, route.charId, remoteAuthHeader);
            } else {
              captureRemoteFile(body, route.charId, remoteAuthHeader);
            }
          } catch (e) {
            console.error('[DB-Proxy] capture/reconcile remote error:', e);
          }
        });
        return;
      }

      case 'read-coldstorage': {
        const canAccelerate = isDbReady() && cb.allowRequest();
        if (canAccelerate) {
          try {
            handleReadColdStorage(req, res, route.key);
            cb.onSuccess();
            return;
          } catch (err) {
            cb.onFailure();
            console.error('[DB-Proxy] read-coldstorage fallback:', (err as Error).message);
          }
        }
        // Bypass
        forwardRequest(req, res);
        return;
      }

      case 'write-database': {
        if (isDbReady()) {
          try {
            handleWriteDatabase(req, res, getDb());
            return;
          } catch (err) {
            console.error('[DB-Proxy] write-database handler error, bypassing:', (err as Error).message);
          }
        }
        forwardRequest(req, res);
        return;
      }

      case 'write-remote': {
        if (isDbReady()) {
          try {
            handleWriteRemote(req, res, route.charId, getDb());
            return;
          } catch (err) {
            console.error('[DB-Proxy] write-remote handler error, bypassing:', (err as Error).message);
          }
        }
        forwardRequest(req, res);
        return;
      }

      case 'passthrough':
      default:
        forwardRequest(req, res);
        return;
    }
  });

  server.listen(PORT, () => {
    console.log(`[DB-Proxy] Listening on :${PORT}`);
    console.log(`[DB-Proxy] Upstream: ${UPSTREAM.protocol}//${UPSTREAM.host}`);
    console.log(`[DB-Proxy] Hydration: ${hydrationState}`);
  });
}

main();
