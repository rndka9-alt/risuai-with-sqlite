import crypto from 'crypto';
import http from 'http';
import { PORT, UPSTREAM } from './config';
import { forwardRequest, forwardAndTee, decodeFilePath } from './proxy';
import { createCircuitBreaker } from './circuit-breaker';
import { initDb, isDbReady, getDb, getBlock, getBlocksBySource, upsertBlock, upsertChat, upsertCharDetail, getCharDetail, getAllCharDetails, getChat, inTransaction } from './db';
import { parseRisuSave, parseRemoteFile, parseRemotePointer } from './parser';
import { assembleRisuSave } from './assembler';
import { slimCharacter, deepSlimCharacter } from './slim';
import { compressColdStorage, decompressColdStorage } from './cold-compat';
import { writeToUpstream } from './proxy';
import { handleWriteDatabase, handleWriteRemote } from './write-handler';
import { reconcileDatabaseBin, reconcileRemoteFile } from './reconcile';
import { handleProxy2, handleGetActiveJobs, handleJobStream, handleJobAbort, handleJobConsume } from './stream-buffer';
import { getClientJs, injectScriptTag } from './client-bundle';
import { RisuSaveType, type HydrationState } from '../shared/types';

// --- Route classification ---

const REMOTE_FILE_RE = /^remotes\/(.+)\.local\.bin$/;
const COLDSTORAGE_RE = /^coldstorage\/(.+)$/;
const DATABASE_BIN = 'database/database.bin';
const JOB_STREAM_RE = /^\/db\/jobs\/([^/]+)\/stream$/;
const JOB_ABORT_RE = /^\/db\/jobs\/([^/]+)\/abort$/;
const JOB_CONSUME_RE = /^\/db\/jobs\/([^/]+)\/consume$/;
const CHAR_DETAIL_RE = /^\/db\/char-detail\/(.+)$/;

type Route =
  | { type: 'read-database' }
  | { type: 'read-remote'; charId: string }
  | { type: 'read-coldstorage'; key: string }
  | { type: 'write-database' }
  | { type: 'write-remote'; charId: string }
  | { type: 'proxy2' }
  | { type: 'db-client-js' }
  | { type: 'db-jobs-active' }
  | { type: 'db-job-stream'; jobId: string }
  | { type: 'db-job-abort'; jobId: string }
  | { type: 'db-job-consume'; jobId: string }
  | { type: 'db-char-detail'; charId: string }
  | { type: 'db-char-details' }
  | { type: 'root-html' }
  | { type: 'passthrough' };

function classifyRequest(req: http.IncomingMessage): Route {
  const url = req.url || '';

  // DB Proxy endpoints
  if (url === '/db/client.js' && req.method === 'GET') {
    return { type: 'db-client-js' };
  }
  if (url === '/db/jobs/active' && req.method === 'GET') {
    return { type: 'db-jobs-active' };
  }

  const streamMatch = url.match(JOB_STREAM_RE);
  if (streamMatch && req.method === 'GET') {
    return { type: 'db-job-stream', jobId: streamMatch[1] };
  }
  const abortMatch = url.match(JOB_ABORT_RE);
  if (abortMatch && req.method === 'POST') {
    return { type: 'db-job-abort', jobId: abortMatch[1] };
  }
  const consumeMatch = url.match(JOB_CONSUME_RE);
  if (consumeMatch && req.method === 'POST') {
    return { type: 'db-job-consume', jobId: consumeMatch[1] };
  }

  // Char detail endpoints
  if (url === '/db/char-details' && req.method === 'GET') {
    return { type: 'db-char-details' };
  }
  const charDetailMatch = url.match(CHAR_DETAIL_RE);
  if (charDetailMatch && req.method === 'GET') {
    return { type: 'db-char-detail', charId: charDetailMatch[1] };
  }

  // proxy2
  if ((url === '/proxy2' || url.startsWith('/proxy2?')) && req.method === 'POST') {
    return { type: 'proxy2' };
  }

  // Root HTML (for script injection)
  if (url === '/' && req.method === 'GET') {
    return { type: 'root-html' };
  }

  // File API routes
  if (url === '/api/read' || url === '/api/write') {
    const filePath = decodeFilePath(req);
    if (filePath) {
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
    }
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

function captureRemoteFile(body: Buffer, charId: string, authHeader: string | undefined): void {
  if (!isDbReady()) return;
  const db = getDb();

  const block = parseRemoteFile(body, charId);
  if (!block) return;

  const charJson = block.data.toString('utf-8');

  // Phase 1: slim chats → cold markers
  const { slimJson: chatSlimJson, coldEntries } = slimCharacter(charJson, charId);

  // Phase 2: strip heavy fields → char_details
  const { slimJson: deepSlimJson, detailJson } = deepSlimCharacter(chatSlimJson);
  const deepSlimBuffer = Buffer.from(deepSlimJson, 'utf-8');
  const detailCompressed = compressColdStorage(detailJson);
  const detailHash = crypto.createHash('sha256').update(detailJson).digest('hex');

  inTransaction(db, () => {
    upsertBlock(db, `remote:${charId}`, RisuSaveType.CHARACTER_WITH_CHAT, `remote:${charId}`, 0, deepSlimBuffer, block.hash);
    upsertCharDetail(db, charId, detailCompressed, detailHash);
    for (const entry of coldEntries) {
      upsertChat(db, entry.uuid, entry.charId, entry.chatIndex, entry.compressed, entry.hash);
    }
  });

  for (const entry of coldEntries) {
    writeToUpstream(`coldstorage/${entry.uuid}`, entry.compressed, authHeader);
  }

  capturedRemotes.add(charId);
  checkHydrationComplete();
}

// --- Read handlers ---

function handleReadDatabase(req: http.IncomingMessage, res: http.ServerResponse): void {
  const db = getDb();
  const rows = getBlocksBySource(db, 'database.bin');
  if (rows.length === 0) throw new Error('No database.bin blocks in cache');

  const binary = assembleRisuSave(
    rows.map((r) => ({
      name: r.name,
      type: r.type as RisuSaveType,
      data: r.data,
      compress: r.compression === 1,
    })),
  );

  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(binary.length) });
  res.end(binary);
}

function handleReadRemote(req: http.IncomingMessage, res: http.ServerResponse, charId: string): void {
  const db = getDb();
  const block = getBlock(db, `remote:${charId}`);
  if (!block) throw new Error(`Remote ${charId} not in cache`);

  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(block.data.length) });
  res.end(block.data);
}

function handleReadColdStorage(req: http.IncomingMessage, res: http.ServerResponse, key: string): void {
  const db = getDb();
  const chat = getChat(db, key);
  if (!chat) throw new Error(`Cold storage ${key} not in cache`);

  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(chat.data.length) });
  res.end(chat.data);
}

// --- Char detail handlers ---

function handleGetCharDetail(req: http.IncomingMessage, res: http.ServerResponse, charId: string): void {
  const db = getDb();
  const row = getCharDetail(db, charId);
  if (!row) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const json = decompressColdStorage(row.data);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(json)),
    'cache-control': 'no-cache',
  });
  res.end(json);
}

function handleGetAllCharDetails(req: http.IncomingMessage, res: http.ServerResponse): void {
  const db = getDb();
  const rows = getAllCharDetails(db);
  const result: Record<string, any> = {};

  for (const row of rows) {
    try {
      const json = decompressColdStorage(row.data);
      result[row.charId] = JSON.parse(json);
    } catch {
      // Skip corrupted entries
    }
  }

  const body = JSON.stringify(result);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

// --- HTML injection handler ---

function handleRootHtml(req: http.IncomingMessage, res: http.ServerResponse): void {
  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';

      if (!contentType.includes('text/html')) {
        // Not HTML — pass through
        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }

      // Buffer HTML, inject script tag
      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf-8');
        html = injectScriptTag(html);

        const headers = { ...proxyRes.headers };
        headers['content-length'] = String(Buffer.byteLength(html));
        delete headers['content-encoding']; // Injected content is not compressed
        res.writeHead(proxyRes.statusCode!, headers);
        res.end(html);
      });
    },
  );

  req.pipe(proxyReq);
  proxyReq.on('error', (err) => {
    console.error('[DB-Proxy] root HTML proxy error:', err.message);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Bad Gateway');
  });
}

// --- Server ---

const cb = createCircuitBreaker();

function main(): void {
  try {
    initDb();
    console.log('[DB-Proxy] SQLite initialized');
  } catch (err) {
    console.error('[DB-Proxy] SQLite init failed, running in pure proxy mode:', err);
  }

  const server = http.createServer((req, res) => {
    const route = classifyRequest(req);

    switch (route.type) {
      // --- DB Proxy endpoints ---
      case 'db-client-js': {
        const js = getClientJs();
        res.writeHead(200, {
          'content-type': 'application/javascript',
          'content-length': String(Buffer.byteLength(js)),
          'cache-control': 'no-cache',
        });
        res.end(js);
        return;
      }

      case 'db-jobs-active': {
        if (!isDbReady()) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobs: [] }));
          return;
        }
        handleGetActiveJobs(req, res, getDb());
        return;
      }

      case 'db-job-stream': {
        if (!isDbReady()) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'DB not ready' }));
          return;
        }
        handleJobStream(req, res, route.jobId, getDb());
        return;
      }

      case 'db-job-abort': {
        if (!isDbReady()) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'DB not ready' }));
          return;
        }
        handleJobAbort(req, res, route.jobId, getDb());
        return;
      }

      case 'db-job-consume': {
        if (!isDbReady()) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }
        handleJobConsume(req, res, route.jobId, getDb());
        return;
      }

      // --- Char detail endpoints ---
      case 'db-char-detail': {
        if (!isDbReady()) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'DB not ready' }));
          return;
        }
        handleGetCharDetail(req, res, route.charId);
        return;
      }

      case 'db-char-details': {
        if (!isDbReady()) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        handleGetAllCharDetails(req, res);
        return;
      }

      // --- proxy2 ---
      case 'proxy2': {
        if (isDbReady()) {
          handleProxy2(req, res, getDb());
        } else {
          forwardRequest(req, res);
        }
        return;
      }

      // --- HTML injection ---
      case 'root-html': {
        handleRootHtml(req, res);
        return;
      }

      // --- File API routes ---
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
        const dbAuthHeader = typeof req.headers['risu-auth'] === 'string' ? req.headers['risu-auth'] : undefined;
        forwardAndTee(req, res, (status, body) => {
          if (status < 200 || status >= 300 || body.length === 0 || !isDbReady()) return;
          try {
            if (hydrationState === 'HOT') reconcileDatabaseBin(getDb(), body);
            else captureDatabaseBin(body, dbAuthHeader);
          } catch (e) { console.error('[DB-Proxy] capture/reconcile database.bin error:', e); }
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
        const remoteAuthHeader = typeof req.headers['risu-auth'] === 'string' ? req.headers['risu-auth'] : undefined;
        forwardAndTee(req, res, (status, body) => {
          if (status < 200 || status >= 300 || body.length === 0 || !isDbReady()) return;
          try {
            if (hydrationState === 'HOT') reconcileRemoteFile(getDb(), body, route.charId, remoteAuthHeader);
            else captureRemoteFile(body, route.charId, remoteAuthHeader);
          } catch (e) { console.error('[DB-Proxy] capture/reconcile remote error:', e); }
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
        forwardRequest(req, res);
        return;
      }

      case 'write-database': {
        if (isDbReady()) {
          try { handleWriteDatabase(req, res, getDb()); return; }
          catch (err) { console.error('[DB-Proxy] write-database error, bypassing:', (err as Error).message); }
        }
        forwardRequest(req, res);
        return;
      }

      case 'write-remote': {
        if (isDbReady()) {
          try { handleWriteRemote(req, res, route.charId, getDb()); return; }
          catch (err) { console.error('[DB-Proxy] write-remote error, bypassing:', (err as Error).message); }
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
    console.log(`[DB-Proxy] Stream buffer: enabled`);
  });
}

main();
