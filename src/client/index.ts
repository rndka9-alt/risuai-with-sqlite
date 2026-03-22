/**
 * DB-Proxy client bundle entry point.
 * Injected into RisuAI HTML via <script defer src="/db/client.js"></script>
 */

import { installBatchRemotes } from './batch-remotes';
import { installBatchWrite } from './batch-write';
import { installFileListDataset } from './file-list-dataset';
import { install as installFetchPatch } from './fetch-patch';
import { recoverJobs } from './recovery';
import { installDetailLoader } from './detail-loader';
import { checkProxyConfig } from './proxy-config-check';

// Start batch remote prefetch ASAP (before fetch patch so it uses original fetch)
installBatchRemotes();

// Fetch file-list dataset (before fetch patch so it uses original fetch)
installFileListDataset();

// Store reference to real fetch for batch-write replay (before patch)
installBatchWrite(window.fetch);

// Patch fetch to add target character header + batch intercept + file-list cache + batch write
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
