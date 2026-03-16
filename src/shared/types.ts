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
  data: Buffer;
  hash: string;
}

export interface ChatData {
  key: string;
  charId: string;
  chatIndex: number;
  data: Buffer;
  hash: string;
}
