/**
 * Monkey-patch fetch to:
 * 1. Add x-dbproxy-target-char header to POST /proxy2 requests
 * 2. Capture x-dbproxy-job-id from response headers
 */

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

function setHeader(headers: HeadersInit, key: string, value: string): void {
  if (headers instanceof Headers) {
    headers.set(key, value);
  } else if (Array.isArray(headers)) {
    headers.push([key, value]);
  } else {
    (headers as Record<string, string>)[key] = value;
  }
}

const originalFetch = window.fetch;

const patchedFetch: typeof fetch = function (input, init) {
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

  return originalFetch.call(window, input, init!);
};

export function install(): void {
  window.fetch = patchedFetch;
}
