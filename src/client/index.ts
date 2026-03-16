/**
 * DB-Proxy client bundle entry point.
 * Injected into RisuAI HTML via <script defer src="/db/client.js"></script>
 */

import { install as installFetchPatch } from './fetch-patch';
import { recoverJobs } from './recovery';

// Patch fetch to add target character header
installFetchPatch();

// Wait for DOM ready, then recover any pending jobs
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // Delay slightly to let RisuAI initialize __pluginApis__
    setTimeout(recoverJobs, 2000);
  });
} else {
  setTimeout(recoverJobs, 2000);
}
