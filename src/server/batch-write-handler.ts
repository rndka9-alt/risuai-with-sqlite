import http from 'http';
import Database from 'better-sqlite3';
import { RISU_AUTH_HEADER } from './config';
import { bufferBody, writeToUpstream, writeToUpstreamWithStatus } from './proxy';
import { parseRemoteFile } from './parser';
import { slimRemote, mergeCharacterDetail } from './slim';
import { decompressColdStorage } from './cold-compat';
import { upsertBlock, upsertChat, upsertCharDetail, getCharDetail, inTransaction, addToFileListCache } from './db';
import { RisuSaveType } from '../shared/types';
import * as log from './logger';

const REMOTE_FILE_RE = /^remotes\/(.+)\.local\.bin$/;

interface BatchEntry {
  filePath: string;
  body: Buffer;
}

/**
 * Deserialize the batch-write binary payload.
 *
 * Wire format:
 *   [Uint32LE: count]
 *   For each entry:
 *     [Uint16LE: hexPathLen]
 *     [UTF-8: hexPath]
 *     [Uint32LE: dataLen]
 *     [bytes: body]
 */
function deserializeBatch(buf: Buffer): BatchEntry[] {
  const entries: BatchEntry[] = [];
  if (buf.length < 4) return entries;

  let offset = 0;
  const count = buf.readUInt32LE(offset);
  offset += 4;

  for (let i = 0; i < count; i++) {
    if (offset + 2 > buf.length) break;
    const hexPathLen = buf.readUInt16LE(offset);
    offset += 2;

    if (offset + hexPathLen > buf.length) break;
    const hexPath = buf.subarray(offset, offset + hexPathLen).toString('utf-8');
    offset += hexPathLen;

    if (offset + 4 > buf.length) break;
    const dataLen = buf.readUInt32LE(offset);
    offset += 4;

    if (offset + dataLen > buf.length) break;
    const body = buf.subarray(offset, offset + dataLen);
    offset += dataLen;

    const filePath = Buffer.from(hexPath, 'hex').toString('utf-8');
    entries.push({ filePath, body: Buffer.from(body) });
  }

  return entries;
}

/**
 * For remote files: merge __strippedFields from stored char_details.
 */
async function mergeDetailIfNeeded(
  body: Buffer,
  charId: string,
  db: Database.Database,
): Promise<Buffer> {
  try {
    const charJson = body.toString('utf-8');
    const parsed = JSON.parse(charJson);

    if (Array.isArray(parsed.__strippedFields)) {
      const storedDetail = getCharDetail(db, charId);
      if (storedDetail) {
        const detailJson = await decompressColdStorage(storedDetail.data);
        const fullJson = mergeCharacterDetail(charJson, detailJson);
        return Buffer.from(fullJson, 'utf-8');
      }
      log.warn('batch-write: __strippedFields but no stored detail', { charId });
    }
  } catch (err) {
    log.warn('batch-write: detail merge failed', { charId, error: String(err) });
  }
  return body;
}

/**
 * Background: parse, slim, and upsert a single remote entry into SQLite.
 */
function backgroundRemoteUpsert(
  body: Buffer,
  charId: string,
  authHeader: string | undefined,
  db: Database.Database,
): void {
  setImmediate(async () => {
    try {
      const block = parseRemoteFile(body, charId);
      if (!block) return;

      const charJson = block.data.toString('utf-8');
      const slimmed = await slimRemote(charJson, charId);

      inTransaction(db, () => {
        upsertBlock(db, `remote:${charId}`, RisuSaveType.CHARACTER_WITH_CHAT, `remote:${charId}`, 0, slimmed.deepSlimBuffer, block.hash);
        upsertCharDetail(db, charId, slimmed.detailCompressed, slimmed.detailHash);
        for (const entry of slimmed.coldEntries) {
          upsertChat(db, entry.uuid, entry.charId, entry.chatIndex, entry.compressed, entry.hash);
        }
      });

      for (const entry of slimmed.coldEntries) {
        writeToUpstream(`coldstorage/${entry.uuid}`, entry.compressed, authHeader);
      }
    } catch (err) {
      log.error('batch-write background upsert error', { charId, error: String(err) });
    }
  });
}

/**
 * Handle POST /db/batch-write.
 *
 * Accepts ANY file paths (remotes, database.bin, .meta, backups, etc).
 * 1. Deserialize batch
 * 2. For remote entries: detail-merge if needed
 * 3. Forward all to upstream in parallel
 * 4. If any fail → 502
 * 5. On success: update file_list_cache, background SQLite upsert for remotes
 */
export async function handleBatchWrite(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database,
): Promise<void> {
  const rawBody = await bufferBody(req);
  const entries = deserializeBatch(rawBody);

  if (entries.length === 0) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: 0 }));
    return;
  }

  const authHeader = typeof req.headers[RISU_AUTH_HEADER] === 'string'
    ? req.headers[RISU_AUTH_HEADER]
    : undefined;

  log.info('batch-write start', { count: String(entries.length) });

  // Prepare bodies (detail-merge for remotes) + forward all to upstream in parallel
  const results = await Promise.all(
    entries.map(async (entry) => {
      const remoteMatch = entry.filePath.match(REMOTE_FILE_RE);
      const body = remoteMatch
        ? await mergeDetailIfNeeded(entry.body, remoteMatch[1], db)
        : entry.body;
      const status = await writeToUpstreamWithStatus(entry.filePath, body, authHeader);
      return { filePath: entry.filePath, body, charId: remoteMatch?.[1], status };
    }),
  );

  const failed = results.filter((r) => r.status < 200 || r.status >= 300);

  if (failed.length > 0) {
    log.warn('batch-write partial failure', {
      total: String(entries.length),
      failed: String(failed.length),
      paths: failed.map((f) => `${f.filePath}:${f.status}`).join(','),
    });
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, total: entries.length, failed: failed.length }));
    return;
  }

  // All succeeded
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, count: entries.length }));

  // Background: file_list_cache + SQLite upsert for remotes
  for (const r of results) {
    addToFileListCache(db, r.filePath);
    if (r.charId) {
      backgroundRemoteUpsert(r.body, r.charId, authHeader, db);
    }
  }
}
