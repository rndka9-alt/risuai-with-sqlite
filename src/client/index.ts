/**
 * DB-Proxy client bundle entry point.
 * Injected into RisuAI HTML via <script defer src="/db/client.js"></script>
 */

import { installBatchRemotes } from './batch-remotes';
import { installFileListDataset } from './file-list-dataset';
import { install as installFetchPatch } from './fetch-patch';
import { installDetailLoader } from './detail-loader';
import { checkProxyConfig } from './proxy-config-check';

// Start batch remote prefetch ASAP (before fetch patch so it uses original fetch)
installBatchRemotes();

// Fetch file-list dataset (before fetch patch so it uses original fetch)
installFileListDataset();

// Patch fetch to add target character header + batch intercept + file-list cache
installFetchPatch();

// Background: load stripped character detail fields
installDetailLoader();

// Check proxy config for usePlainFetch warning
checkProxyConfig();

