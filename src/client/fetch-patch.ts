/**
 * Monkey-patch fetch to:
 * 1. Capture risu-auth from /api/* requests, inject into /db/* requests
 * 2. Add x-dbproxy-target-char header to POST /proxy2 requests
 * 3. Capture x-dbproxy-job-id from response headers
 * 4. Serve remote file reads from batch cache when available
 */

import { tryServeBatchRemote, utf8ToHex } from './batch-remotes';
import { tryServeFileList, tryServeMetaRead, onFileRemove } from './file-list-dataset';
import { getPluginApis } from '../utils/getPluginApis';

/** Track the most recent job ID from proxy2 responses */
export let lastJobId: string | null = null;

/** Cached risu-auth token captured from /api/* requests */
let cachedAuth: string | null = null;

/**
 * Find the character most likely to be the target of the next LLM request.
 * Uses the same heuristic as the sync server: character with the most recent message.
 */
function findStreamTarget(): string | null {
  try {
    const db = getPluginApis()?.getDatabase();
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
  // Remaining case: Record<string, string>
  const entries = Object.entries(headers);
  const match = entries.find(([k]) => k.toLowerCase() === key.toLowerCase());
  return match ? match[1] : null;
}

// hex-encoded prefix for "remotes/"
const REMOTES_HEX_PREFIX = utf8ToHex('remotes/');

function hexToUtf8(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function setHeader(headers: HeadersInit, key: string, value: string): void {
  if (headers instanceof Headers) {
    headers.set(key, value);
  } else if (Array.isArray(headers)) {
    headers.push([key, value]);
  } else {
    headers[key] = value;
  }
}

/** 클라이언트 rid 생성: 체인 전체에서 동일 요청 추적용 */
function generateRid(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${ts}-${rand}`;
}

const originalFetch = window.fetch;

const patchedFetch: typeof fetch = function (input, init) {
  // 모든 요청에 x-request-id 주입 (없을 때만)
  if (init?.headers && !getHeader(init.headers, 'x-request-id')) {
    setHeader(init.headers, 'x-request-id', generateRid());
  }

  // Capture risu-auth from /api/* requests
  if (typeof input === 'string' && input.startsWith('/api/')) {
    const auth = getHeader(init?.headers, 'risu-auth');
    if (auth) cachedAuth = auth;
  }

  // Inject cached risu-auth into /db/* requests
  if (typeof input === 'string' && input.startsWith('/db/') && cachedAuth) {
    if (!init) init = {};
    if (!init.headers) init.headers = {};
    setHeader(init.headers, 'risu-auth', cachedAuth);
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

  // Intercept GET /api/list → serve from file-list dataset
  if (input === '/api/list' && (!init?.method || init.method === 'GET')) {
    const cached = tryServeFileList();
    if (cached) {
      return cached.then((resp) =>
        resp ?? originalFetch.call(window, input, init)
      );
    }
  }

  // Intercept GET /api/read for remote files → serve from batch cache or meta dataset
  if (input === '/api/read' && (!init?.method || init.method === 'GET')) {
    const filePath = getHeader(init?.headers, 'file-path');
    if (filePath && filePath.startsWith(REMOTES_HEX_PREFIX)) {
      // .meta file → serve lastUsed from dataset
      const decoded = hexToUtf8(filePath);
      if (decoded.endsWith('.meta') && !decoded.includes('.meta.meta')) {
        const metaResp = tryServeMetaRead(decoded);
        if (metaResp) return Promise.resolve(metaResp);
      }

      // Remote character file → serve from batch cache
      const cached = tryServeBatchRemote(filePath);
      if (cached) {
        return cached.then((resp) =>
          resp ?? originalFetch.call(window, input, init)
        );
      }
    }
  }

  if (input === '/api/remove' && (!init?.method || init.method === 'GET')) {
    const filePath = getHeader(init?.headers, 'file-path');
    if (filePath) {
      return originalFetch.call(window, input, init).then((resp) => {
        if (resp.ok) onFileRemove(hexToUtf8(filePath));
        return resp;
      });
    }
  }

  return originalFetch.call(window, input, init);
};

export function install(): void {
  window.fetch = patchedFetch;
}
