/**
 * RisuAI host application exposes __pluginApis__ as a runtime global.
 * The host app cannot be modified (separate project), so we declare
 * only the subset of the API surface that this proxy's client code uses.
 *
 * Access the global through getPluginApis() wrapper — do not use
 * __pluginApis__ directly. See src/utils/getPluginApis/.
 */

export interface RisuCharacter {
  chaId: string;
  chatPage?: number;
  reloadKeys?: number;
  __strippedFields?: string[];
  chats?: Array<{
    message?: Array<{ role: string; data: string; time?: number; saying?: string }>;
    isStreaming?: boolean;
  }>;
  // detail-loader merges arbitrary heavy fields (desc, systemPrompt, etc.)
  // into characters at runtime, so an index signature is needed.
  [key: string]: any;
}

export interface PluginApis {
  getDatabase(): {
    characters: RisuCharacter[];
  };
}
