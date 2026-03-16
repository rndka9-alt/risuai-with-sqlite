/** RisuSave block types (mirrors RisuAI's RisuSaveType enum) */
export const enum RisuSaveType {
  CONFIG = 0,
  ROOT = 1,
  CHARACTER_WITH_CHAT = 2,
  CHAT = 3,
  BOTPRESET = 4,
  MODULES = 5,
  REMOTE = 6,
  CHARACTER_WITHOUT_CHAT = 7,
  ROOT_COMPONENT = 8,
}

export interface ParsedBlock {
  name: string;
  type: RisuSaveType;
  compression: 0 | 1;
  data: Buffer;
  hash: string;
}

export interface ChatEntry {
  uuid: string;
  charId: string;
  chatIndex: number;
  data: Buffer; // gzip-compressed chat JSON (fflate-compatible)
  hash: string;
}

/** Hydration state */
export type HydrationState = 'COLD' | 'WARMING' | 'HOT';

/** Streaming job status */
export type JobStatus = 'streaming' | 'completed' | 'failed' | 'aborted';

export interface Job {
  id: string;
  charId: string | null;
  status: JobStatus;
  response: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Client → Server: active jobs query response */
export interface ActiveJobsResponse {
  jobs: Job[];
}
