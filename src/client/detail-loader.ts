/**
 * Background detail loader: after initial page load, fetch heavy character
 * fields stripped by deep-slim and merge them back into the in-memory database.
 *
 * Flow:
 * 1. Wait for __pluginApis__ to become available
 * 2. GET /db/char-details → all character detail fields at once
 * 3. For each character with __strippedFields, merge the detail and remove the marker
 * 4. Trigger Svelte reactivity via reloadKeys
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

/**
 * Merge detail fields into a character object and clear the stripped marker.
 */
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

/**
 * Fetch all character details and merge into the in-memory database.
 */
async function loadAllDetails(): Promise<void> {
  if (typeof __pluginApis__ === 'undefined') return;
  const db = __pluginApis__?.getDatabase();
  if (!db?.characters) return;

  // Check if any characters need detail loading
  const needsDetail = db.characters.some((c) => c && Array.isArray(c.__strippedFields));
  if (!needsDetail) return;

  const resp = await fetch('/db/char-details');
  if (!resp.ok) return;

  const details: DetailMap = await resp.json();

  for (const char of db.characters) {
    if (!char || !Array.isArray(char.__strippedFields)) continue;
    const detail = details[char.chaId];
    if (detail) {
      mergeDetail(char, detail);
    }
  }
}

/**
 * Wait for __pluginApis__ then start background loading.
 */
function waitAndLoad(): void {
  let attempts = 0;
  const maxAttempts = 30; // ~15 seconds

  const check = () => {
    attempts++;
    if (typeof __pluginApis__ !== 'undefined' && __pluginApis__?.getDatabase()?.characters) {
      loadAllDetails().catch((err) => {
        console.error('[DB-Proxy] detail loader error:', err);
      });
      return;
    }
    if (attempts < maxAttempts) {
      setTimeout(check, 500);
    }
  };

  check();
}

export function installDetailLoader(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // Delay to let RisuAI finish initial load
      setTimeout(waitAndLoad, 3000);
    });
  } else {
    setTimeout(waitAndLoad, 3000);
  }
}
