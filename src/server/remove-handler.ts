import http from 'http';
import Database from 'better-sqlite3';
import { getCharDetailBlobs } from './db';
import { decompressColdStorage } from './cold-compat';
import { removeFromFileListCache } from './db';
import { forwardRequest, forwardAndTee } from './proxy';
import * as log from './logger';

/**
 * Asset path patterns that getUncleanables() in RisuAI checks
 * against deep-slim stripped fields: emotionImages, additionalAssets, ccAssets.
 *
 * If an asset is referenced in any of these fields (stored in char_details),
 * we must block the remove — the client can't see the reference because
 * deep-slim replaced the field with an empty array.
 */

/**
 * Check if an asset filename appears in any char_details blob.
 * Returns true if the asset is referenced (should be protected).
 */
async function isAssetReferenced(
  db: Database.Database,
  assetPath: string,
): Promise<boolean> {
  const rows = getCharDetailBlobs(db);
  if (rows.length === 0) return false;

  // Extract the basename for matching — char data may store
  // just the filename or a relative path like "assets/abc.png"
  const basename = assetPath.split('/').pop() ?? assetPath;

  for (const row of rows) {
    try {
      const json = await decompressColdStorage(row.data);
      if (json.includes(basename)) {
        return true;
      }
    } catch {
      // Decompression failure — skip this entry
    }
  }

  return false;
}

/**
 * Handle GET /api/remove for assets/*.
 *
 * 1. Check char_details for references to the asset
 * 2. If referenced → return success without forwarding (protect from deep-slim false positive)
 * 3. If not referenced → forward to upstream (legitimate cleanup)
 * 4. On any error → fallback to upstream (P1: transparency)
 */
export async function handleRemoveAsset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  db: Database.Database,
): Promise<void> {
  try {
    const referenced = await isAssetReferenced(db, filePath);

    if (referenced) {
      log.info('Blocked asset remove (referenced in char_details)', { filePath });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    log.debug('Asset not referenced, forwarding remove', { filePath });
  } catch (err) {
    log.warn('Asset reference check failed, falling back to upstream', {
      filePath,
      error: String(err),
    });
  }

  // Not referenced or error → forward to upstream
  forwardRequest(req, res);
}

/**
 * Handle GET /api/remove for non-asset files (e.g. database/dbbackup-*.bin).
 *
 * Uses forwardAndTee to inspect the upstream response body.
 * If upstream returns 500 with ENOENT (file already gone), cleans
 * the ghost entry from file_list_cache so /api/list stops returning it.
 *
 * 2xx success → cache cleaned by the res.on('finish') handler in index.ts.
 * 500 + ENOENT → cache cleaned here (ghost entry removal).
 * Other errors → cache untouched (file may still exist).
 */
export function handleRemoveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  db: Database.Database,
): void {
  forwardAndTee(req, res, (status, body) => {
    if (status >= 200 && status < 300) {
      // 2xx: res.on('finish') handler in index.ts handles cache removal
      return;
    }
    if (status === 500) {
      const bodyStr = body.toString('utf-8');
      if (bodyStr.includes('ENOENT')) {
        log.info('Remove got ENOENT from upstream, cleaning ghost cache entry', { filePath });
        removeFromFileListCache(db, filePath);
      }
    }
  });
}
