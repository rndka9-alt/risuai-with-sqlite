import crypto from 'crypto';
import http from 'http';
import { PORT, UPSTREAM, CLIENT_ID_HEADER, REQUEST_ID_HEADER, RISU_AUTH_HEADER, FILE_PATH_HEADER } from './config';
import { forwardRequest, forwardAndTee, forwardBufferAndTransform, decodeFilePath, fetchFromUpstream } from './proxy';
import { createCircuitBreaker } from './circuit-breaker';
import { initDb, resetDb, isDbReady, getDb, getBlock, getBlocksBySource, getAllRemoteBlocks, upsertBlock, upsertChat, upsertCharDetail, getCharDetail, getAllCharDetails, getChat, inTransaction, populateFileListCache, getFileListCache, isFileListCacheReady, addToFileListCache, removeFromFileListCache, upsertMetaLastUsed, getMetaEntries, getMetaMissingLastUsed } from './db';
import { parseRisuSave, parseRemoteFile, parseRemotePointer } from './parser';
import { assembleRisuSave } from './assembler';
import { slimCharacter, deepSlimCharacter } from './slim';
import { compressColdStorage, decompressColdStorage } from './cold-compat';
import { writeToUpstream } from './proxy';
import { handleWriteDatabase, handleWriteRemote } from './write-handler';
import { handleRemoveAsset } from './remove-handler';
import { reconcileDatabaseBin, reconcileRemoteFile } from './reconcile';
import { handleProxy2, handleGetActiveJobs, handleJobStream, handleJobAbort, handleJobConsume } from './stream-buffer';
import { getClientJs, injectScriptTag } from './client-bundle';
import * as log from './logger';
import { RisuSaveType, toRisuSaveType, type HydrationState } from '../shared/types';
import { getUsePlainFetch, setUsePlainFetch } from './proxy-config-state';
import { initAuth, isAuthReady, issueInternalToken, verifyClientAuth } from './auth';

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
  | { type: 'db-batch-remotes' }
  | { type: 'db-file-list-dataset' }
  | { type: 'proxy-config' }
  | { type: 'root-html' }
  | { type: 'list-files' }
  | { type: 'remove-asset'; filePath: string }
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

  // File list dataset endpoint
  if (url === '/db/file-list-dataset' && req.method === 'GET') {
    return { type: 'db-file-list-dataset' };
  }

  // Batch remotes endpoint
  if (url === '/db/batch-remotes' && req.method === 'GET') {
    return { type: 'db-batch-remotes' };
  }

  // Char detail endpoints
  if (url === '/db/char-details' && req.method === 'GET') {
    return { type: 'db-char-details' };
  }
  const charDetailMatch = url.match(CHAR_DETAIL_RE);
  if (charDetailMatch && req.method === 'GET') {
    return { type: 'db-char-detail', charId: charDetailMatch[1] };
  }

  // Proxy config (chaining endpoint)
  if (url === '/.proxy/config' && req.method === 'GET') {
    return { type: 'proxy-config' };
  }

  // proxy2
  if ((url === '/proxy2' || url.startsWith('/proxy2?')) && req.method === 'POST') {
    return { type: 'proxy2' };
  }

  // Root HTML (for script injection)
  if (url === '/' && req.method === 'GET') {
    return { type: 'root-html' };
  }

  // GET /api/list → .meta.meta 필터링
  if (url === '/api/list' && req.method === 'GET') {
    return { type: 'list-files' };
  }

  // GET /api/remove → asset protection
  if (url === '/api/remove' && req.method === 'GET') {
    const filePath = decodeFilePath(req);
    if (filePath && filePath.startsWith('assets/')) {
      return { type: 'remove-asset', filePath };
    }
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
let storedAuthHeader: string | undefined;
const pendingBatchRequests: Array<{ res: http.ServerResponse; timer: ReturnType<typeof setTimeout> }> = [];

const BATCH_WAIT_TIMEOUT_MS = 30_000;

/**
 * If all expected remotes have been captured, transition to HOT and flush
 * pending batch requests. Returns the resolved hydration state so callers
 * can branch without relying on side-effect mutation.
 */
function resolveHydration(): HydrationState {
  if (hydrationState !== 'WARMING') return hydrationState;
  if (capturedRemotes.size < expectedRemoteCount) return hydrationState;

  log.info('Hydration complete. State: HOT', { remotesCached: capturedRemotes.size });
  flushPendingBatchRequests();
  return 'HOT';
}

function flushPendingBatchRequests(): void {
  if (pendingBatchRequests.length === 0) return;
  if (!isDbReady()) return;

  const db = getDb();
  const remotes = getAllRemoteBlocks(db);

  let totalSize = 4;
  for (const r of remotes) {
    const charId = r.name.slice(7);
    totalSize += 1 + Buffer.byteLength(charId) + 4 + r.data.length;
  }

  const buf = Buffer.alloc(totalSize);
  let off = 0;
  buf.writeUInt32LE(remotes.length, off); off += 4;
  for (const r of remotes) {
    const charId = r.name.slice(7);
    const charIdBuf = Buffer.from(charId, 'utf-8');
    buf[off++] = charIdBuf.length;
    charIdBuf.copy(buf, off); off += charIdBuf.length;
    buf.writeUInt32LE(r.data.length, off); off += 4;
    r.data.copy(buf, off); off += r.data.length;
  }

  log.info('Flushing pending batch-remotes', { count: String(pendingBatchRequests.length), remotes: String(remotes.length) });

  for (const pending of pendingBatchRequests) {
    clearTimeout(pending.timer);
    if (!pending.res.writableEnded) {
      pending.res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(buf.length),
        'cache-control': 'no-cache',
      });
      pending.res.end(buf);
    }
  }
  pendingBatchRequests.length = 0;
}

/** Proactively fetch all remotes from upstream after database.bin is captured. */
async function proactiveHydration(charIds: string[], authHeader: string | undefined): Promise<void> {
  log.info('Proactive hydration started', { remotes: String(charIds.length) });
  const t0 = performance.now();

  await Promise.all(
    charIds.map(async (charId) => {
      if (capturedRemotes.has(charId)) return;
      const body = await fetchFromUpstream(`remotes/${charId}.local.bin`, authHeader);
      if (body && body.length > 0) {
        await captureRemoteFile(body, charId, authHeader);
      } else {
        log.warn('Proactive fetch failed', { charId });
      }
    }),
  );

  log.info('Proactive hydration finished', { ms: (performance.now() - t0).toFixed(0), captured: capturedRemotes.size + '/' + expectedRemoteCount });
}

function captureDatabaseBin(body: Buffer, authHeader: string | undefined): void {
  if (!isDbReady()) return;
  const db = getDb();

  const result = parseRisuSave(body);
  if (!result) {
    log.error('Failed to parse database.bin for hydration');
    return;
  }

  storedAuthHeader = authHeader;
  const charIds: string[] = [];

  inTransaction(db, () => {
    for (const block of result.blocks) {
      upsertBlock(db, block.name, block.type, 'database.bin', block.compression, block.data, block.hash);
      if (block.type === RisuSaveType.REMOTE) {
        const ptr = parseRemotePointer(block.data);
        if (ptr) {
          expectedRemoteCount++;
          charIds.push(ptr.charId);
        }
      }
      if (block.type === RisuSaveType.ROOT) {
        extractUsePlainFetch(block.data);
      }
    }
  });

  hydrationState = 'WARMING';
  log.info('database.bin captured, State: WARMING', {
    blocks: result.blocks.length,
    remotesExpected: expectedRemoteCount,
  });
  hydrationState = resolveHydration();

  // Proactively fetch all remotes from upstream (non-blocking)
  if (hydrationState !== 'HOT' && charIds.length > 0) {
    proactiveHydration(charIds, authHeader)
      .catch((e) => log.error('Proactive hydration error', { error: String(e) }));
  }
}

async function captureRemoteFile(body: Buffer, charId: string, authHeader: string | undefined): Promise<void> {
  if (!isDbReady()) return;
  const db = getDb();
  const t0 = performance.now();

  const block = parseRemoteFile(body, charId);
  if (!block) return;

  const charJson = block.data.toString('utf-8');
  const t1 = performance.now();

  // Phase 1: slim chats → cold markers (parallel gzip on libuv threads)
  const { slimJson: chatSlimJson, coldEntries } = await slimCharacter(charJson, charId);
  const t2 = performance.now();

  // Phase 2: deep slim → compress → DB → upstream write
  //
  // This pipeline is intentionally duplicated with handleWriteRemote() in write-handler.ts.
  // Both load character data into the SQLite cache, but in different contexts:
  //   - here: proactive hydration from upstream (awaited, owns db access, tracks hydration state)
  //   - handleWriteRemote: background processing after a client write-through (setImmediate, db passed in, error-logged)
  // Merging would couple the hydration lifecycle to the write path.
  const { slimJson: deepSlimJson, detailJson } = deepSlimCharacter(chatSlimJson);
  const deepSlimBuffer = Buffer.from(deepSlimJson, 'utf-8');
  const detailCompressed = await compressColdStorage(detailJson);
  const detailHash = crypto.createHash('sha256').update(detailJson).digest('hex');
  const t3 = performance.now();

  inTransaction(db, () => {
    upsertBlock(db, `remote:${charId}`, RisuSaveType.CHARACTER_WITH_CHAT, `remote:${charId}`, 0, deepSlimBuffer, block.hash);
    upsertCharDetail(db, charId, detailCompressed, detailHash);
    for (const entry of coldEntries) {
      upsertChat(db, entry.uuid, entry.charId, entry.chatIndex, entry.compressed, entry.hash);
    }
  });
  const t4 = performance.now();

  for (const entry of coldEntries) {
    writeToUpstream(`coldstorage/${entry.uuid}`, entry.compressed, authHeader);
  }

  capturedRemotes.add(charId);
  log.info('captureRemoteFile timing', {
    charId,
    bodyKB: String((body.length / 1024).toFixed(0)),
    coldEntries: String(coldEntries.length),
    parse: (t1 - t0).toFixed(0) + 'ms',
    slim: (t2 - t1).toFixed(0) + 'ms',
    deepSlim: (t3 - t2).toFixed(0) + 'ms',
    sqlite: (t4 - t3).toFixed(0) + 'ms',
    total: (t4 - t0).toFixed(0) + 'ms',
    captured: capturedRemotes.size + '/' + expectedRemoteCount,
  });
  hydrationState = resolveHydration();
}

// --- Read handlers ---

function handleReadDatabase(req: http.IncomingMessage, res: http.ServerResponse): void {
  const db = getDb();
  const rows = getBlocksBySource(db, 'database.bin');
  if (rows.length === 0) throw new Error('No database.bin blocks in cache');

  const binary = assembleRisuSave(
    rows.map((r) => ({
      name: r.name,
      type: toRisuSaveType(r.type) ?? RisuSaveType.CONFIG,
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

async function handleGetCharDetail(req: http.IncomingMessage, res: http.ServerResponse, charId: string): Promise<void> {
  const db = getDb();
  const row = getCharDetail(db, charId);
  if (!row) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const json = await decompressColdStorage(row.data);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(json)),
    'cache-control': 'no-cache',
  });
  res.end(json);
}

async function handleGetAllCharDetails(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const db = getDb();
  const rows = getAllCharDetails(db);

  const entries = await Promise.all(
    rows.map(async (row) => {
      try {
        const json = await decompressColdStorage(row.data);
        return [row.charId, JSON.parse(json)] as const;
      } catch {
        return null;
      }
    }),
  );

  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry) result[entry[0]] = entry[1];
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
    log.error('Root HTML proxy error', { error: err.message });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Bad Gateway');
  });
}

// --- usePlainFetch extraction ---

function extractUsePlainFetch(rootBlockData: Buffer): void {
  try {
    const parsed: Record<string, unknown> = JSON.parse(rootBlockData.toString('utf-8'));
    if (typeof parsed.usePlainFetch === 'boolean') {
      setUsePlainFetch(parsed.usePlainFetch);
    }
  } catch {
    // ROOT block parse failure — ignore, usePlainFetch stays unknown
  }
}

// --- Proxy config handler ---

function handleProxyConfig(req: http.IncomingMessage, res: http.ServerResponse): void {
  const proxyReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: '/.proxy/config',
      method: 'GET',
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (proxyRes) => {
      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let upstream: Record<string, unknown> = {};
        if (proxyRes.statusCode === 200) {
          try {
            const parsed: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (typeof parsed === 'object' && parsed !== null) {
              upstream = parsed;
            }
          } catch { /* start fresh */ }
        }

        upstream['withSqlite'] = {
          hydrationState,
          usePlainFetch: getUsePlainFetch(),
        };

        const body = JSON.stringify(upstream);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'cache-control': 'no-cache',
        });
        res.end(body);
      });
    },
  );

  proxyReq.on('error', () => {
    const body = JSON.stringify({
      withSqlite: {
        hydrationState,
        usePlainFetch: getUsePlainFetch(),
      },
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-cache',
    });
    res.end(body);
  });

  proxyReq.end();
}

// --- Server ---

const cb = createCircuitBreaker();

function main(): void {
  try {
    const db = initDb();
    resetDb(db);
    log.info('SQLite initialized (fresh start)');
  } catch (err) {
    log.error('SQLite init failed, running in pure proxy mode', { error: String(err) });
  }

  const server = http.createServer((req, res) => {
    const route = classifyRequest(req);
    const reqStart = performance.now();

    // Propagate or generate request ID for cross-service tracing
    const rid = (typeof req.headers[REQUEST_ID_HEADER] === 'string' && req.headers[REQUEST_ID_HEADER])
      || (typeof req.headers['cf-ray'] === 'string' && req.headers['cf-ray'])
      || crypto.randomBytes(8).toString('hex');
    req.headers[REQUEST_ID_HEADER] = rid;

    // Ensure client ID header is always present — client patch may not be loaded
    if (typeof req.headers[CLIENT_ID_HEADER] !== 'string') {
      req.headers[CLIENT_ID_HEADER] = `srv-${crypto.randomBytes(8).toString('hex')}`;
    }

    log.debug('Request', { rid, method: req.method, url: req.url, route: route.type });

    res.on('finish', () => {
      const duration = (performance.now() - reqStart).toFixed(0);
      const logFields: Record<string, string | undefined> = { rid, method: req.method, url: req.url, route: route.type, status: String(res.statusCode), ms: duration };
      // file-path 헤더가 있으면 디코딩해서 로그에 포함 (backup 이슈 추적용)
      const rawFp = req.headers[FILE_PATH_HEADER];
      if (typeof rawFp === 'string' && rawFp.length > 0) {
        logFields.filePath = decodeFilePath(req) ?? rawFp;
      }
      log.info('Response', logFields);

      // Sync file_list_cache on successful write/remove
      if (isDbReady() && res.statusCode >= 200 && res.statusCode < 300) {
        const filePath = decodeFilePath(req);
        if (filePath) {
          const url = req.url || '';
          if (url === '/api/write' && req.method === 'POST') {
            addToFileListCache(getDb(), filePath);
            // .meta writes: store lastUsed (write time ≈ client's Date.now())
            if (filePath.endsWith('.meta') && filePath.startsWith('remotes/') && !filePath.includes('.meta.meta')) {
              upsertMetaLastUsed(getDb(), filePath, Date.now());
            }
          } else if (url === '/api/remove' && req.method === 'GET') {
            removeFromFileListCache(getDb(), filePath);
          }
        }
      }
    });

    // --- Auth check for /db/* data endpoints ---
    if (route.type.startsWith('db-') && route.type !== 'db-client-js') {
      const clientAuth = typeof req.headers[RISU_AUTH_HEADER] === 'string'
        ? req.headers[RISU_AUTH_HEADER] : null;
      if (!clientAuth) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'No auth header' }));
        return;
      }
      verifyClientAuth(clientAuth).then((valid) => {
        if (!valid) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        handleRoute();
      }).catch(() => {
        // Auth check failed — fall through to serve anyway (P1: availability)
        handleRoute();
      });
      return;
    }

    handleRoute();

    function handleRoute(): void {
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

      case 'db-file-list-dataset': {
        if (!isDbReady() || !isFileListCacheReady(getDb())) {
          res.writeHead(204);
          res.end();
          return;
        }
        // Hydrate missing .meta lastUsed from upstream before responding
        (async () => {
          try {
            const db = getDb();
            const missing = getMetaMissingLastUsed(db);
            if (missing.length > 0) {
              const authHeader = typeof req.headers[RISU_AUTH_HEADER] === 'string'
                ? req.headers[RISU_AUTH_HEADER] : storedAuthHeader;
              await Promise.all(missing.map(async (metaPath) => {
                try {
                  const body = await fetchFromUpstream(metaPath, authHeader);
                  if (body && body.length > 0) {
                    const parsed: { lastUsed?: number } = JSON.parse(body.toString('utf-8'));
                    if (typeof parsed.lastUsed === 'number') {
                      upsertMetaLastUsed(db, metaPath, parsed.lastUsed);
                    }
                  }
                } catch {
                  // Skip — client will fall back to normal fetch for this one
                }
              }));
            }

            const files = getFileListCache(db);
            const filtered = files.filter((f) => !f.includes('.meta.meta'));
            const metaEntries = getMetaEntries(db);
            const meta: Record<string, number> = {};
            for (const entry of metaEntries) {
              meta[entry.path] = entry.lastUsed;
            }
            const payload = JSON.stringify({ files: filtered, meta, timestamp: Date.now() });
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(payload)),
              'cache-control': 'no-cache',
            });
            res.end(payload);
          } catch (err) {
            log.warn('file-list-dataset error', { error: String(err) });
            if (!res.headersSent) {
              res.writeHead(204);
              res.end();
            }
          }
        })();
        return;
      }

      case 'db-batch-remotes': {
        if (!isDbReady()) {
          res.writeHead(204);
          res.end();
          return;
        }
        if (hydrationState !== 'HOT') {
          // Hold request until hydration completes (proactive fetch in progress)
          const timer = setTimeout(() => {
            const idx = pendingBatchRequests.findIndex((p) => p.res === res);
            if (idx !== -1) pendingBatchRequests.splice(idx, 1);
            if (!res.writableEnded) {
              log.warn('batch-remotes timeout, sending 204');
              res.writeHead(204);
              res.end();
            }
          }, BATCH_WAIT_TIMEOUT_MS);
          pendingBatchRequests.push({ res, timer });
          res.on('close', () => {
            const idx = pendingBatchRequests.findIndex((p) => p.res === res);
            if (idx !== -1) {
              clearTimeout(pendingBatchRequests[idx].timer);
              pendingBatchRequests.splice(idx, 1);
            }
          });
          return;
        }
        const db = getDb();
        const remotes = getAllRemoteBlocks(db);

        let totalSize = 4;
        for (const r of remotes) {
          const charId = r.name.slice(7); // strip 'remote:'
          totalSize += 1 + Buffer.byteLength(charId) + 4 + r.data.length;
        }

        const buf = Buffer.alloc(totalSize);
        let off = 0;
        buf.writeUInt32LE(remotes.length, off); off += 4;

        for (const r of remotes) {
          const charId = r.name.slice(7);
          const charIdBuf = Buffer.from(charId, 'utf-8');
          buf[off++] = charIdBuf.length;
          charIdBuf.copy(buf, off); off += charIdBuf.length;
          buf.writeUInt32LE(r.data.length, off); off += 4;
          r.data.copy(buf, off); off += r.data.length;
        }

        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(buf.length),
          'cache-control': 'no-cache',
        });
        res.end(buf);
        return;
      }

      // --- Proxy config ---
      case 'proxy-config': {
        handleProxyConfig(req, res);
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
            log.warn('read-database fallback to upstream', { error: err instanceof Error ? err.message : String(err) });
          }
        }
        const dbAuthHeader = typeof req.headers[RISU_AUTH_HEADER] === 'string' ? req.headers[RISU_AUTH_HEADER] : undefined;
        forwardAndTee(req, res, (status, body) => {
          if (status < 200 || status >= 300 || body.length === 0 || !isDbReady()) return;
          try {
            if (hydrationState === 'HOT') reconcileDatabaseBin(getDb(), body);
            else captureDatabaseBin(body, dbAuthHeader);
          } catch (e) { log.error('capture/reconcile database.bin error', { error: String(e) }); }
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
            log.warn('read-remote fallback to upstream', { charId: route.charId, error: err instanceof Error ? err.message : String(err) });
          }
        }
        const remoteAuthHeader = typeof req.headers[RISU_AUTH_HEADER] === 'string' ? req.headers[RISU_AUTH_HEADER] : undefined;
        if (isDbReady() && hydrationState !== 'HOT') {
          // COLD/WARMING: buffer → slim → serve optimized data to client
          forwardBufferAndTransform(req, res, async (status, _headers, body) => {
            if (status < 200 || status >= 300 || body.length === 0) return null;
            try {
              await captureRemoteFile(body, route.charId, remoteAuthHeader);
              // Serve the deep-slimmed version from SQLite
              const db = getDb();
              const block = getBlock(db, `remote:${route.charId}`);
              if (block) {
                log.debug('Serving slimmed remote during hydration', { charId: route.charId });
                return block.data;
              }
            } catch (e) { log.error('capture remote error during hydration', { charId: route.charId, error: String(e) }); }
            return null; // fallback to original body
          });
        } else {
          // HOT bypass (reconcile) or DB not ready: tee as before
          forwardAndTee(req, res, (status, body) => {
            if (status < 200 || status >= 300 || body.length === 0 || !isDbReady()) return;
            reconcileRemoteFile(getDb(), body, route.charId, remoteAuthHeader)
              .catch((e) => { log.error('reconcile remote error', { charId: route.charId, error: String(e) }); });
          });
        }
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
            log.warn('read-coldstorage fallback to upstream', { key: route.key, error: err instanceof Error ? err.message : String(err) });
          }
        }
        forwardRequest(req, res);
        return;
      }

      case 'write-database': {
        if (isDbReady()) {
          try { handleWriteDatabase(req, res, getDb()); return; }
          catch (err) { log.warn('write-database error, bypassing', { error: err instanceof Error ? err.message : String(err) }); }
        }
        forwardRequest(req, res);
        return;
      }

      case 'write-remote': {
        if (isDbReady()) {
          try { handleWriteRemote(req, res, route.charId, getDb()); return; }
          catch (err) { log.warn('write-remote error, bypassing', { charId: route.charId, error: err instanceof Error ? err.message : String(err) }); }
        }
        forwardRequest(req, res);
        return;
      }

      // --- GET /api/list ---
      // SQLite file_list_cache가 있으면 로컬 서빙, 없으면 upstream에서 받아와 캐시 적재.
      // .meta.meta 이상은 필터링 (클라이언트 버그: 체인 무한 성장 방지).
      case 'list-files': {
        if (isDbReady() && isFileListCacheReady(getDb())) {
          try {
            const paths = getFileListCache(getDb());
            const filtered = paths.filter((entry) => !entry.includes('.meta.meta'));
            const body = JSON.stringify({ content: filtered });
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body)),
              'cache-control': 'no-cache',
            });
            res.end(body);
            return;
          } catch (err) {
            log.warn('file_list_cache read failed, falling back to upstream', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Cache miss or error → fetch from upstream and populate cache
        forwardBufferAndTransform(req, res, (status, _headers, body) => {
          if (status < 200 || status >= 300) return null;
          try {
            const data = JSON.parse(body.toString('utf-8'));
            if (data.content && Array.isArray(data.content)) {
              // Populate cache from upstream response
              if (isDbReady()) {
                setImmediate(() => {
                  try {
                    populateFileListCache(getDb(), data.content);
                    log.info('file_list_cache populated', { entries: data.content.length });
                  } catch (err) {
                    log.warn('file_list_cache populate failed', { error: String(err) });
                  }
                });
              }
              data.content = data.content.filter((entry: string) => !entry.includes('.meta.meta'));
            }
            return Buffer.from(JSON.stringify(data), 'utf-8');
          } catch {
            return null;
          }
        });
        return;
      }

      case 'remove-asset': {
        if (isDbReady()) {
          handleRemoveAsset(req, res, route.filePath, getDb());
          return;
        }
        forwardRequest(req, res);
        return;
      }

      case 'passthrough':
      default:
        forwardRequest(req, res);
        return;
    }
    } // handleRoute
  });

  server.listen(PORT, () => {
    log.info('Server started', {
      port: PORT,
      upstream: `${UPSTREAM.protocol}//${UPSTREAM.host}`,
      hydration: hydrationState,
      streamBuffer: 'enabled',
    });

    // Self-auth → proactive hydration (non-blocking)
    initAuth()
      .then(async () => {
        if (!isAuthReady() || !isDbReady()) return;
        const token = await issueInternalToken();
        if (!token) return;

        // Hydrate file list cache
        const listBody = await fetchFromUpstream('', token, '/api/list');
        if (listBody && listBody.length > 0) {
          try {
            const data: { content?: string[] } = JSON.parse(listBody.toString('utf-8'));
            if (data.content && Array.isArray(data.content)) {
              populateFileListCache(getDb(), data.content);
              log.info('Proactive file_list_cache hydration complete', { entries: data.content.length });
            }
          } catch (e) {
            log.warn('Proactive file list hydration parse error', { error: String(e) });
          }
        }

        // Hydrate .meta lastUsed
        const missing = getMetaMissingLastUsed(getDb());
        if (missing.length > 0) {
          await Promise.all(missing.map(async (metaPath) => {
            try {
              const body = await fetchFromUpstream(metaPath, token);
              if (body && body.length > 0) {
                const parsed: { lastUsed?: number } = JSON.parse(body.toString('utf-8'));
                if (typeof parsed.lastUsed === 'number') {
                  upsertMetaLastUsed(getDb(), metaPath, parsed.lastUsed);
                }
              }
            } catch { /* skip */ }
          }));
          log.info('Proactive .meta hydration complete', { count: missing.length });
        }
      })
      .catch((e) => log.warn('Proactive hydration error', { error: String(e) }));
  });
}

main();
