/**
 * DB-Proxy client bundle entry point.
 * Injected into RisuAI HTML via <script defer src="/db/client.js"></script>
 */

import { installBatchRemotes } from './batch-remotes';
import { install as installFetchPatch } from './fetch-patch';
import { recoverJobs } from './recovery';
import { installDetailLoader } from './detail-loader';
import { checkProxyConfig } from './proxy-config-check';

// Start batch remote prefetch ASAP (before fetch patch so it uses original fetch)
installBatchRemotes();

// Patch fetch to add target character header + batch intercept
installFetchPatch();

// Background: load stripped character detail fields
installDetailLoader();

// Check proxy config for usePlainFetch warning
checkProxyConfig();

// Wait for DOM ready, then recover any pending jobs
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // Delay slightly to let RisuAI initialize __pluginApis__
    setTimeout(recoverJobs, 2000);
  });
} else {
  setTimeout(recoverJobs, 2000);
}
