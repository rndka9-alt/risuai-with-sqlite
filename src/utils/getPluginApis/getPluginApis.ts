import type { PluginApis } from '../../types/plugin-apis';

// Module-scoped ambient declaration for the runtime global.
// Confined to this file — all other code accesses it through the wrapper below.
declare const __pluginApis__: PluginApis | undefined;

/**
 * Access the RisuAI host app's __pluginApis__ global.
 * Returns undefined when the host hasn't initialized yet or is unavailable.
 */
export function getPluginApis(): PluginApis | undefined {
  if (typeof __pluginApis__ === 'undefined') return undefined;
  return __pluginApis__;
}
