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
