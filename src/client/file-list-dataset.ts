/**
 * Client-side /api/list cache.
 *
 * On boot, fetches a file-list dataset from with-sqlite (GET /db/file-list-dataset).
 * The dataset contains the full file list + a timestamp.
 * If the dataset is fresh (< 24h), subsequent GET /api/list calls are served
 * from this in-memory cache — zero network round-trips.
 *
 * If the dataset is missing or stale, /api/list calls bypass normally.
 */

const FRESHNESS_MS = 24 * 60 * 60 * 1000; // 24 hours

interface FileListDataset {
  files: string[];
  meta: Record<string, number>; // path → lastUsed
  timestamp: number;
}

let dataset: FileListDataset | null = null;
let datasetPromise: Promise<void> | null = null;

function isFresh(): boolean {
  if (!dataset) return false;
  return Date.now() - dataset.timestamp < FRESHNESS_MS;
}

/**
 * Fetch the dataset from with-sqlite. Called once at boot.
 */
export function installFileListDataset(): void {
  datasetPromise = fetch('/db/file-list-dataset')
    .then((resp) => {
      if (!resp.ok) return;
      return resp.json().then((data: FileListDataset) => {
        if (data && Array.isArray(data.files) && typeof data.timestamp === 'number') {
          if (!data.meta) data.meta = {};
          dataset = data;
        }
      });
    })
    .catch(() => {
      // Silently fail — /api/list calls will just bypass
    });
}

/**
 * Try to serve a GET /api/list from the cached dataset.
 * Returns a synthetic Response if the cache is fresh, null otherwise.
 *
 * If the dataset fetch is still in-flight, waits for it to complete first.
 */
export function tryServeFileList(): Promise<Response | null> | null {
  // Dataset already loaded
  if (dataset) {
    if (!isFresh()) return null;
    return Promise.resolve(buildResponse(dataset));
  }

  // Dataset fetch still in-flight — wait for it
  if (datasetPromise) {
    return datasetPromise.then(() => {
      if (dataset && isFresh()) return buildResponse(dataset);
      return null;
    });
  }

  return null;
}

/**
 * Update the local dataset when a write or remove succeeds.
 * Keeps the cache consistent within the same session.
 */
export function onFileWrite(path: string): void {
  if (!dataset) return;
  if (!dataset.files.includes(path)) {
    dataset.files.push(path);
  }
}

export function onFileRemove(path: string): void {
  if (!dataset) return;
  const idx = dataset.files.indexOf(path);
  if (idx !== -1) {
    dataset.files.splice(idx, 1);
  }
}

/**
 * Try to serve a GET /api/read for a .meta file from the cached dataset.
 * Returns a synthetic Response with { lastUsed } if available, null otherwise.
 */
export function tryServeMetaRead(filePath: string): Response | null {
  if (!dataset || !isFresh()) return null;
  const lastUsed = dataset.meta[filePath];
  if (lastUsed === undefined) return null;

  const body = new TextEncoder().encode(JSON.stringify({ lastUsed }));
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
}

function buildResponse(ds: FileListDataset): Response {
  const body = JSON.stringify({ content: ds.files });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
