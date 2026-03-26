/** RisuSave block types (mirrors RisuAI's RisuSaveType enum) */
export enum RisuSaveType {
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

const RISU_SAVE_TYPE_VALUES = new Set<number>(
  Object.values(RisuSaveType).filter((v): v is number => typeof v === 'number'),
);

/** Type guard: narrow a number to RisuSaveType */
export function toRisuSaveType(val: number): RisuSaveType | null {
  return RISU_SAVE_TYPE_VALUES.has(val) ? val : null;
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

