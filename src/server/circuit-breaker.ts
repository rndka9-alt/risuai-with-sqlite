import { CB_FAILURE_THRESHOLD, CB_RESET_TIMEOUT_MS } from './config';

export type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreaker {
  readonly state: CBState;
  /** Returns true if the circuit allows an accelerated (non-bypass) attempt */
  allowRequest(): boolean;
  /** Record a successful DB operation */
  onSuccess(): void;
  /** Record a failed DB operation */
  onFailure(): void;
}

export function createCircuitBreaker(): CircuitBreaker {
  let state: CBState = 'CLOSED';
  let failureCount = 0;
  let openedAt = 0;
  let halfOpenAttempted = false;

  return {
    get state() {
      // Check if OPEN should transition to HALF_OPEN
      if (state === 'OPEN' && Date.now() - openedAt >= CB_RESET_TIMEOUT_MS) {
        state = 'HALF_OPEN';
        halfOpenAttempted = false;
      }
      return state;
    },

    allowRequest(): boolean {
      // Re-check state (triggers OPEN→HALF_OPEN transition if timeout elapsed)
      const current = this.state;

      if (current === 'CLOSED') return true;
      if (current === 'OPEN') return false;

      // HALF_OPEN: allow exactly one attempt
      if (current === 'HALF_OPEN' && !halfOpenAttempted) {
        halfOpenAttempted = true;
        return true;
      }
      return false;
    },

    onSuccess(): void {
      failureCount = 0;
      state = 'CLOSED';
      halfOpenAttempted = false;
    },

    onFailure(): void {
      failureCount++;

      if (state === 'HALF_OPEN') {
        // Half-open probe failed → back to OPEN
        state = 'OPEN';
        openedAt = Date.now();
        halfOpenAttempted = false;
        return;
      }

      if (failureCount >= CB_FAILURE_THRESHOLD) {
        state = 'OPEN';
        openedAt = Date.now();
        console.warn(
          `[CircuitBreaker] OPEN after ${failureCount} failures. Bypass for ${CB_RESET_TIMEOUT_MS}ms.`,
        );
      }
    },
  };
}
