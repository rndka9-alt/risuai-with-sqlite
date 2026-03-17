/**
 * Detail loader with full-screen loading overlay.
 *
 * Shows a blocking overlay until all stripped character fields are restored,
 * preventing user interaction with incomplete data (empty systemPrompt,
 * missing lorebook, etc.).
 *
 * Flow:
 * 1. Show full-screen overlay immediately
 * 2. Poll for __pluginApis__ availability
 * 3. Check if any characters have __strippedFields
 *    - If none (COLD state / no deep-slim): dismiss overlay immediately
 * 4. GET /db/char-details → merge all detail fields
 * 5. Dismiss overlay
 */

declare const __pluginApis__: {
  getDatabase(): {
    characters: Array<{
      chaId: string;
      reloadKeys?: number;
      __strippedFields?: string[];
      [key: string]: any;
    }>;
  };
} | undefined;

interface DetailMap {
  [charId: string]: Record<string, any>;
}

// --- Overlay UI ---

let overlay: HTMLDivElement | null = null;

function showOverlay(): void {
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.id = 'dbproxy-loading-overlay';
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:999999',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'background:rgba(0,0,0,0.6)',
    'backdrop-filter:blur(4px)',
    'transition:opacity 0.3s',
  ].join(';');

  const inner = document.createElement('div');
  inner.style.cssText = [
    'color:#ecf0f1',
    'font-size:16px',
    'text-align:center',
    'font-family:system-ui,sans-serif',
  ].join(';');

  // Spinner
  const spinner = document.createElement('div');
  spinner.style.cssText = [
    'width:40px',
    'height:40px',
    'margin:0 auto 16px',
    'border:3px solid rgba(255,255,255,0.2)',
    'border-top-color:#ecf0f1',
    'border-radius:50%',
    'animation:dbproxy-spin 0.8s linear infinite',
  ].join(';');

  const style = document.createElement('style');
  style.textContent = '@keyframes dbproxy-spin{to{transform:rotate(360deg)}}';

  inner.appendChild(spinner);
  inner.appendChild(document.createTextNode('Loading character data...'));
  overlay.appendChild(style);
  overlay.appendChild(inner);

  // Attach to body if ready, otherwise wait
  if (document.body) {
    document.body.appendChild(overlay);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (overlay) document.body.appendChild(overlay);
    });
  }
}

function dismissOverlay(): void {
  if (!overlay) return;
  overlay.style.opacity = '0';
  const el = overlay;
  setTimeout(() => el.remove(), 300);
  overlay = null;
}

// --- Detail merge ---

function mergeDetail(char: any, detail: Record<string, any>): void {
  const stripped: string[] = char.__strippedFields;
  if (!Array.isArray(stripped)) return;

  for (const field of stripped) {
    if (field in detail) {
      char[field] = detail[field];
    }
  }

  delete char.__strippedFields;
  char.reloadKeys = (char.reloadKeys || 0) + 1;
}

/** Returns true if stripped fields were found and loading was needed. */
async function loadAllDetails(): Promise<boolean> {
  if (typeof __pluginApis__ === 'undefined') return false;
  const db = __pluginApis__?.getDatabase();
  if (!db?.characters) return false;

  // No stripped fields → proxy is in COLD state or no deep-slim applied
  const needsDetail = db.characters.some((c) => c && Array.isArray(c.__strippedFields));
  if (!needsDetail) return false;

  showOverlay();

  const resp = await fetch('/db/char-details');
  if (!resp.ok) return true;

  const details: DetailMap = await resp.json();

  for (const char of db.characters) {
    if (!char || !Array.isArray(char.__strippedFields)) continue;
    const detail = details[char.chaId];
    if (detail) {
      mergeDetail(char, detail);
    }
  }
  return true;
}

// --- Main loop ---

const API_POLL_INTERVAL = 300;
const API_POLL_MAX = 100; // ~30 seconds total
const FAILSAFE_TIMEOUT = 35_000; // dismiss overlay no matter what

function waitForApiAndLoad(): void {
  let attempts = 0;

  const check = () => {
    attempts++;

    if (typeof __pluginApis__ !== 'undefined' && __pluginApis__?.getDatabase()?.characters) {
      let failsafe: ReturnType<typeof setTimeout> | undefined;
      loadAllDetails()
        .then((needed) => {
          if (needed) {
            failsafe = setTimeout(dismissOverlay, FAILSAFE_TIMEOUT);
          }
        })
        .catch((err) => console.error('[DB-Proxy] detail loader error:', err))
        .finally(() => {
          if (failsafe) clearTimeout(failsafe);
          dismissOverlay();
        });
      return;
    }

    if (attempts < API_POLL_MAX) {
      setTimeout(check, API_POLL_INTERVAL);
    }
  };

  check();
}

export function installDetailLoader(): void {
  waitForApiAndLoad();
}
