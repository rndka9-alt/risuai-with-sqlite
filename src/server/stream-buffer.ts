import http from 'http';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { UPSTREAM, DBPROXY_TARGET_HEADER, DBPROXY_JOB_ID_HEADER } from './config';
import { createJob, appendJobResponse, updateJobStatus, getJob, getActiveJobs, deleteJob, isDbReady, getDb } from './db';
import * as log from './logger';

// --- Active stream tracking (in-memory, complements SQLite) ---

interface ActiveStream {
  jobId: string;
  proxyReq: http.ClientRequest;
  accumulatedText: string;
  lineBuffer: string;
  subscribers: Set<http.ServerResponse>; // SSE subscribers for replay+live
  clientDisconnected: boolean;
  createdAt: number;
}

const activeStreams = new Map<string, ActiveStream>();

/** Zombie stream cleanup: upstream 무응답 시 30분 후 정리 */
const STREAM_TTL_MS = 30 * 60 * 1000;

const streamCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [jobId, stream] of activeStreams) {
    if (now - stream.createdAt < STREAM_TTL_MS) continue;

    log.warn('Stale stream cleaned up', { jobId, ageSeconds: String(Math.round((now - stream.createdAt) / 1000)) });

    if (!stream.proxyReq.destroyed) {
      stream.proxyReq.destroy();
    }

    try {
      if (isDbReady()) {
        const db = getDb();
        appendJobResponse(db, jobId, stream.accumulatedText);
        updateJobStatus(db, jobId, 'failed', 'stream timeout');
      }
    } catch (err) {
      log.debug('Zombie stream DB cleanup failed', { jobId, error: String(err) });
    }

    for (const sub of stream.subscribers) {
      if (!sub.writableEnded) {
        sub.write(`data: ${JSON.stringify({ type: 'error', error: 'stream timeout' })}\n\n`);
        sub.end();
      }
    }

    activeStreams.delete(jobId);
  }
}, 60_000);
streamCleanupTimer.unref();

// --- SSE Delta Parsing (forked from sync server) ---

function parseSSEDeltas(raw: string): string[] {
  const deltas: string[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    const payload = trimmed.slice(6).trim();
    if (payload === '[DONE]' || payload === '') continue;

    try {
      const json = JSON.parse(payload);

      // OpenAI format: choices[].delta.content
      if (json.choices && Array.isArray(json.choices)) {
        for (const choice of json.choices) {
          const content = choice?.delta?.content;
          if (typeof content === 'string') {
            deltas.push(content);
          }
        }
        continue;
      }

      // Anthropic format: content_block_delta → delta.text
      if (json.type === 'content_block_delta') {
        const text = json.delta?.text;
        if (typeof text === 'string') {
          deltas.push(text);
        }
        continue;
      }
    } catch (err) {
      log.debug('SSE line JSON parse failed, skipping', { line, error: String(err) });
    }
  }

  return deltas;
}

// --- proxy2 handler ---

export function handleProxy2(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database,
): void {
  const targetCharId = typeof req.headers[DBPROXY_TARGET_HEADER] === 'string'
    ? req.headers[DBPROXY_TARGET_HEADER]
    : null;

  const jobId = crypto.randomUUID();

  // Create job in SQLite
  createJob(db, jobId, targetCharId);

  // Strip our custom header before forwarding
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
      const contentType = proxyRes.headers['content-type'] || '';
      const isSSE = contentType.includes('text/event-stream');

      if (!isSSE) {
        // Non-streaming response: pass through, mark job completed
        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => {
          res.write(chunk);
          chunks.push(chunk);
        });
        proxyRes.on('end', () => {
          res.end();
          const body = Buffer.concat(chunks).toString('utf-8');
          appendJobResponse(db, jobId, body);
          updateJobStatus(db, jobId, 'completed');
        });
        return;
      }

      // SSE streaming response
      const stream: ActiveStream = {
        jobId,
        proxyReq,
        accumulatedText: '',
        lineBuffer: '',
        subscribers: new Set(),
        clientDisconnected: false,
        createdAt: Date.now(),
      };
      activeStreams.set(jobId, stream);

      // Send job ID to client via custom header
      const responseHeaders = { ...proxyRes.headers, [DBPROXY_JOB_ID_HEADER]: jobId };
      res.writeHead(proxyRes.statusCode!, responseHeaders);

      // Detect client disconnect
      res.on('close', () => {
        stream.clientDisconnected = true;
      });

      proxyRes.on('data', (chunk: Buffer) => {
        // Pipe to client if still connected
        if (!stream.clientDisconnected && !res.writableEnded) {
          res.write(chunk);
        }

        // Pipe to SSE subscribers (reconnected clients)
        for (const sub of stream.subscribers) {
          if (!sub.writableEnded) {
            sub.write(`data: ${JSON.stringify({ text: stream.accumulatedText })}\n\n`);
          }
        }

        // Parse deltas and accumulate
        stream.lineBuffer += chunk.toString('utf-8');
        const lastNewline = stream.lineBuffer.lastIndexOf('\n');
        if (lastNewline === -1) return;

        const complete = stream.lineBuffer.slice(0, lastNewline + 1);
        stream.lineBuffer = stream.lineBuffer.slice(lastNewline + 1);

        const deltas = parseSSEDeltas(complete);
        for (const delta of deltas) {
          stream.accumulatedText += delta;
        }

        // Persist to SQLite periodically (every chunk batch)
        appendJobResponse(db, jobId, stream.accumulatedText);
      });

      proxyRes.on('end', () => {
        // Process remaining line buffer
        if (stream.lineBuffer.trim()) {
          const deltas = parseSSEDeltas(stream.lineBuffer);
          for (const delta of deltas) {
            stream.accumulatedText += delta;
          }
        }

        appendJobResponse(db, jobId, stream.accumulatedText);
        updateJobStatus(db, jobId, 'completed');

        // Close client and subscribers
        if (!res.writableEnded) res.end();
        for (const sub of stream.subscribers) {
          sub.write(`data: ${JSON.stringify({ type: 'done', text: stream.accumulatedText })}\n\n`);
          sub.end();
        }

        activeStreams.delete(jobId);
      });

      proxyRes.on('error', (err) => {
        log.error('Stream error', { jobId, error: err.message });
        updateJobStatus(db, jobId, 'failed', err.message);

        if (!res.writableEnded) res.end();
        for (const sub of stream.subscribers) {
          sub.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
          sub.end();
        }

        activeStreams.delete(jobId);
      });
    },
  );

  req.pipe(proxyReq);

  proxyReq.on('error', (err) => {
    log.error('Stream upstream error', { jobId, error: err.message });
    updateJobStatus(db, jobId, 'failed', err.message);

    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('Bad Gateway');
    activeStreams.delete(jobId);
  });
}

// --- Job API handlers ---

/** GET /db/jobs/active — list active (unconsumed) jobs */
export function handleGetActiveJobs(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database,
): void {
  const rows = getActiveJobs(db);
  const jobs = rows.map((r) => ({
    id: r.id,
    charId: r.char_id,
    status: r.status,
    response: r.response,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  const body = JSON.stringify({ jobs });
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

/** GET /db/jobs/:id/stream — SSE replay + live tail for a streaming job */
export function handleJobStream(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
  db: Database.Database,
): void {
  const job = getJob(db, jobId);
  if (!job) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Job not found' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });

  // Send accumulated text so far
  res.write(`data: ${JSON.stringify({ text: job.response })}\n\n`);

  if (job.status !== 'streaming') {
    // Job already finished — send final event and close
    res.write(`data: ${JSON.stringify({ type: 'done', text: job.response, status: job.status, error: job.error })}\n\n`);
    res.end();
    return;
  }

  // Still streaming — subscribe to live updates
  const stream = activeStreams.get(jobId);
  if (!stream) {
    // Stream not in memory (shouldn't happen if status is 'streaming')
    res.write(`data: ${JSON.stringify({ type: 'done', text: job.response, status: 'completed' })}\n\n`);
    res.end();
    return;
  }

  stream.subscribers.add(res);
  res.on('close', () => {
    stream.subscribers.delete(res);
  });
}

/** POST /db/jobs/:id/abort — abort a streaming job */
export function handleJobAbort(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
  db: Database.Database,
): void {
  const stream = activeStreams.get(jobId);
  if (stream) {
    // Destroy upstream connection
    stream.proxyReq.destroy();

    // Persist partial response
    appendJobResponse(db, jobId, stream.accumulatedText);
    updateJobStatus(db, jobId, 'aborted');

    // Notify subscribers
    for (const sub of stream.subscribers) {
      sub.write(`data: ${JSON.stringify({ type: 'done', text: stream.accumulatedText, status: 'aborted' })}\n\n`);
      sub.end();
    }

    activeStreams.delete(jobId);
  } else {
    // Not actively streaming — update DB if still marked as streaming
    const job = getJob(db, jobId);
    if (job && job.status === 'streaming') {
      updateJobStatus(db, jobId, 'aborted');
    }
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}

/** POST /db/jobs/:id/consume — mark job as consumed (delete) */
export function handleJobConsume(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  jobId: string,
  db: Database.Database,
): void {
  deleteJob(db, jobId);

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}
