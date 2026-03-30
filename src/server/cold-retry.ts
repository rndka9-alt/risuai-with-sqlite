/**
 * Background worker that retries failed cold storage uploads.
 *
 * When a cold storage write fails after immediate retries, the session
 * keeps __ws_cold_status = 'pending'. This worker periodically scans
 * for pending sessions, reconstructs payloads from chat_messages in
 * SQLite, and reattempts the upload using an internal auth token.
 */

import type Database from 'better-sqlite3';
import { getPendingColdSessions, getChatMessagesBySession, getChatSessionByUuid, updateColdStatus } from './db';
import { compressColdStorage } from './cold-compat';
import { writeColdStorageWithRetry } from './proxy';
import { issueInternalToken, isAuthReady } from './auth';
import * as log from './logger';

const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 10;

let timer: ReturnType<typeof setInterval> | null = null;

export function startColdRetryWorker(getDb: () => Database.Database): void {
  timer = setInterval(() => {
    retryColdStorage(getDb).catch((err) =>
      log.error('Cold retry worker failed', { error: String(err) }),
    );
  }, RETRY_INTERVAL_MS);

  log.info('Cold storage retry worker scheduled', { intervalMinutes: 5 });
}

export function stopColdRetryWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function retryColdStorage(getDb: () => Database.Database): Promise<number> {
  if (!isAuthReady()) return 0;

  const token = await issueInternalToken();
  if (!token) {
    log.warn('Cold retry skipped — cannot issue token');
    return 0;
  }

  const db = getDb();
  const pending = getPendingColdSessions(db);
  if (pending.length === 0) return 0;

  log.info('Cold retry: found pending sessions', { count: pending.length });

  let retried = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (session) => {
      try {
        const success = await retrySession(db, session, token);
        if (success) retried++;
      } catch (e) {
        log.warn('Cold retry: session failed', { uuid: session.uuid, error: String(e) });
      }
    }));
  }

  if (retried > 0) {
    log.info('Cold retry: completed', { retried, total: pending.length });
  }
  return retried;
}

async function retrySession(
  db: Database.Database,
  session: { __ws_id: string; uuid: string; __ws_character_id: string },
  authHeader: string,
): Promise<boolean> {
  const sessionRow = getChatSessionByUuid(db, session.uuid);
  if (!sessionRow) {
    // session soft-deleted between query and retry
    updateColdStatus(db, session.__ws_id, null);
    return false;
  }

  const messages = getChatMessagesBySession(db, session.__ws_id);
  if (messages.length === 0) {
    log.warn('Cold retry: no messages for session, clearing pending', { uuid: session.uuid });
    updateColdStatus(db, session.__ws_id, null);
    return false;
  }

  const messageArray = messages.map((msg) => {
    const obj: Record<string, unknown> = {
      role: msg.role,
      data: msg.data,
    };
    if (msg.saying !== null) obj.saying = msg.saying;
    if (msg.name !== null) obj.name = msg.name;
    if (msg.time !== null) obj.time = msg.time;
    if (msg.chat_id !== null) obj.chatId = msg.chat_id;
    if (msg.disabled !== null) obj.disabled = msg.disabled;
    if (msg.is_comment) obj.isComment = true;
    if (msg.other_user) obj.otherUser = true;
    const genInfo = msg.generation_info;
    if (typeof genInfo === 'string' && genInfo !== '{}') {
      try { obj.generationInfo = JSON.parse(genInfo); } catch { /* skip */ }
    }
    const promptInfo = msg.prompt_info;
    if (typeof promptInfo === 'string' && promptInfo !== '{}') {
      try { obj.promptInfo = JSON.parse(promptInfo); } catch { /* skip */ }
    }
    return obj;
  });

  const coldPayload = JSON.stringify({
    message: messageArray,
    hypaV2Data: tryParseJson(sessionRow.hypa_v2),
    hypaV3Data: sessionRow.hypa_v3 ? tryParseJson(sessionRow.hypa_v3) : undefined,
    scriptstate: tryParseJson(sessionRow.script_state),
    localLore: tryParseJson(sessionRow.local_lore),
  });

  const compressed = await compressColdStorage(coldPayload);
  const ok = await writeColdStorageWithRetry(session.uuid, compressed, authHeader);
  if (ok) {
    updateColdStatus(db, session.__ws_id, null);
  }
  return ok;
}

function tryParseJson(val: unknown): unknown {
  if (typeof val !== 'string') return val ?? null;
  try { return JSON.parse(val); } catch { return val; }
}
