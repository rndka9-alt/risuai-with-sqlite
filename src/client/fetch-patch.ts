/**
 * Monkey-patch fetch to:
 * 1. Add x-dbproxy-target-char header to POST /proxy2 requests
 * 2. Capture x-dbproxy-job-id from response headers
 * 3. Serve remote file reads from batch cache when available
 */

import { tryServeBatchRemote } from './batch-remotes';

declare const __pluginApis__: {
  getDatabase(): {
    characters: Array<{
      chaId: string;
      chatPage?: number;
      chats?: Array<{
        message?: Array<{ time?: number }>;
      }>;
    }>;
  };
} | undefined;

/** Track the most recent job ID from proxy2 responses */
export let lastJobId: string | null = null;

/**
 * Find the character most likely to be the target of the next LLM request.
 * Uses the same heuristic as the sync server: character with the most recent message.
 */
function findStreamTarget(): string | null {
  try {
    if (typeof __pluginApis__ === 'undefined') return null;
    const db = __pluginApis__?.getDatabase();
    if (!db?.characters) return null;

    let bestCharId: string | null = null;
    let bestTime = 0;

    for (const char of db.characters) {
      if (!char?.chats) continue;
      const chatPage = char.chatPage ?? 0;
      const chat = char.chats[chatPage];
      if (!chat?.message || chat.message.length === 0) continue;
      const lastMsg = chat.message[chat.message.length - 1];
      const msgTime = lastMsg.time || 0;
      if (msgTime > bestTime) {
        bestTime = msgTime;
        bestCharId = char.chaId;
      }
    }

    return bestCharId;
  } catch {
    return null;
  }
}

function getHeader(headers: HeadersInit | undefined, key: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(key);
  if (Array.isArray(headers)) {
    const entry = headers.find(([k]) => k.toLowerCase() === key.toLowerCase());
    return entry ? entry[1] : null;
  }
  const record = headers as Record<string, string>;
  for (const k of Object.keys(record)) {
    if (k.toLowerCase() === key.toLowerCase()) return record[k];
  }
  return null;
}

// hex-encoded prefix for "remotes/"
const REMOTES_HEX_PREFIX = '72656d6f7465732f';

function setHeader(headers: HeadersInit, key: string, value: string): void {
  if (headers instanceof Headers) {
    headers.set(key, value);
  } else if (Array.isArray(headers)) {
    headers.push([key, value]);
  } else {
    headers[key] = value;
  }
}

const originalFetch = window.fetch;

// /api/list cache: store raw data so each consumer gets a fresh Response
let listCachePromise: Promise<{ status: number; headers: Record<string, string>; body: ArrayBuffer } | null> | null = null;

const patchedFetch: typeof fetch = function (input, init) {
  // Cache GET /api/list — file listing rarely changes during a single page load
  if (input === '/api/list' && (!init?.method || init.method === 'GET')) {
    if (!listCachePromise) {
      listCachePromise = originalFetch.call(window, input, init!).then((resp) => {
        if (!resp.ok) {
          listCachePromise = null;
          return null;
        }
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        return resp.arrayBuffer().then((body) => ({ status: resp.status, headers, body }));
      }).catch(() => {
        listCachePromise = null;
        return null;
      });
    }
    return listCachePromise.then((cached) => {
      if (!cached) return originalFetch.call(window, input, init!);
      return new Response(cached.body.slice(0), { status: cached.status, headers: cached.headers });
    });
  }

  // Invalidate /api/list cache when files change
  // /api/remove is a GET with side effects — force cache bypass to prevent 304
  if (input === '/api/remove') {
    const bypassInit = { ...init, cache: 'no-store' as RequestCache };
    return originalFetch.call(window, input, bypassInit).then((resp) => {
      if (resp.ok) listCachePromise = null;
      return resp;
    });
  }
  if (input === '/api/write' && init?.method === 'POST') {
    return originalFetch.call(window, input, init!).then((resp) => {
      if (resp.ok) listCachePromise = null;
      return resp;
    });
  }

  // Only intercept POST /proxy2
  if (init?.method === 'POST' && (input === '/proxy2' || (typeof input === 'string' && input.startsWith('/proxy2?')))) {
    if (!init.headers) init.headers = {};

    const target = findStreamTarget();
    if (target) {
      setHeader(init.headers, 'x-dbproxy-target-char', target);
    }

    // Wrap response to capture job ID
    return originalFetch.call(window, input, init).then((response) => {
      const jobId = response.headers.get('x-dbproxy-job-id');
      if (jobId) {
        lastJobId = jobId;
      }
      return response;
    });
  }

  // Intercept GET /api/read for remote files → serve from batch cache
  if (input === '/api/read' && (!init?.method || init.method === 'GET')) {
    const filePath = getHeader(init?.headers, 'file-path');
    if (filePath && filePath.startsWith(REMOTES_HEX_PREFIX)) {
      const cached = tryServeBatchRemote(filePath);
      if (cached) {
        return cached.then((resp) =>
          resp ?? originalFetch.call(window, input, init!)
        );
      }
    }
  }

  return originalFetch.call(window, input, init!);
};

export function install(): void {
  window.fetch = patchedFetch;
}
