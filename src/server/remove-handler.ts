import http from 'http';
import Database from 'better-sqlite3';
import { isAssetHashReferenced, removeFromFileListCache } from './db';
import { forwardAndTee } from './proxy';
import { requestFileListReconciliation } from './periodic-sync';
import * as log from './logger';

/**
 * Handle GET /api/remove for assets/*.
 *
 * v2: character_asset_map 인덱스 조회로 참조 확인 (gunzip 루프 제거).
 *
 * 1. character_asset_map에서 에셋 참조 여부 확인
 * 2. 참조 중 → success 반환 (삭제 차단)
 * 3. 참조 없음 → upstream으로 forward
 * 4. 에러 → upstream으로 fallback (P1 투명성)
 */
export async function handleRemoveAsset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  db: Database.Database,
): Promise<void> {
  try {
    // 에셋 경로에서 hash 추출: 'assets/abc123.png' → 'abc123'
    const basename = filePath.split('/').pop() ?? filePath;
    const hash = basename.split('.')[0];

    const referenced = isAssetHashReferenced(db, hash);

    if (referenced) {
      log.info('Blocked asset remove (referenced in character_asset_map)', { filePath });
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

  forwardAndTee(req, res, (status) => {
    if (status >= 400) {
      requestFileListReconciliation(db);
    }
  });
}

/**
 * Handle GET /api/remove for non-asset files.
 * Forward + clean file_list_cache.
 */
export function handleRemoveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  db: Database.Database,
): void {
  forwardAndTee(req, res, (status) => {
    log.info('Remove forwarded, cleaning cache entry', { filePath, status: String(status) });
    removeFromFileListCache(db, filePath);
    if (status >= 400) {
      requestFileListReconciliation(db);
    }
  });
}
