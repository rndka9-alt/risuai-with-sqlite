/**
 * Shared state for /.proxy/config endpoint.
 * Separated to avoid circular imports between index.ts and reconcile.ts.
 */

let usePlainFetch: boolean | null = null;

export function getUsePlainFetch(): boolean | null {
  return usePlainFetch;
}

export function setUsePlainFetch(value: boolean): void {
  usePlainFetch = value;
}

/**
 * Extract usePlainFetch from a ROOT block's raw data and update state.
 */
export function extractUsePlainFetch(rootBlockData: Buffer): void {
  try {
    const parsed: Record<string, unknown> = JSON.parse(rootBlockData.toString('utf-8'));
    if (typeof parsed.usePlainFetch === 'boolean') {
      setUsePlainFetch(parsed.usePlainFetch);
    }
  } catch {
    // ROOT block parse failure — ignore, usePlainFetch stays unknown
  }
}
