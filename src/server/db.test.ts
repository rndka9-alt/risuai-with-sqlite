import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DDL } from './schema';
import {
  generateId,
  characterJsonToColumns, characterColumnsToJson,
  upsertCharacter, getCharacterByCharId, getAllCharacterIds,
  upsertChatSession, getChatSessionsByCharacter, getChatSessionByUuid,
  insertChatMessages, getChatMessagesBySession,
  upsertAsset, getAssetByHash,
  linkCharacterAsset, getAssetMapByCharacter,
  upsertBlock, getBlockByName, getBlocksBySource, getBlockHash, blockCount,
  softDeleteCharacter, softDeleteStaleCharacters,
  softDeleteChatSessionsByCharacter, softDeleteChatMessagesBySession,
  softDeleteAssetMapByCharacter,
  addToFileListCache, getFileListCache, removeFromFileListCache,
  isAssetHashReferenced,
  inTransaction,
} from './db';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(DDL);
  return db;
}

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

// ═══════════════════════════════════════════════════════════════
// characterJsonToColumns ↔ characterColumnsToJson 라운드트립
// ═══════════════════════════════════════════════════════════════

describe('character JSON ↔ columns round-trip', () => {
  const original = {
    chaId: 'char-abc',
    name: 'Alice',
    type: 'character',
    desc: 'A brave adventurer',
    systemPrompt: 'You are Alice.',
    tags: ['fantasy', 'female'],
    globalLore: [{ keys: ['sword'], content: 'A magic sword', order: 1 }],
    emotionImages: [['happy', 'assets/abc.png']],
    utilityBot: true,
    removedQuotes: false,
    chatPage: 2,
    bias: [['bad', -100]],
    extentions: { custom: 'data' },
    chats: [{ message: [] }],
    image: 'assets/main.png',
  };

  it('변환 후 복원하면 원본 필드가 보존됨', () => {
    const { columns, unknownFields } = characterJsonToColumns(original);
    expect(unknownFields).toHaveLength(0);

    const wsId = generateId(db);
    upsertCharacter(db, wsId, 'char-abc', 'hash1', 'remotes/char-abc.local.bin', columns);

    const row = getCharacterByCharId(db, 'char-abc');
    expect(row).toBeDefined();

    const restored = characterColumnsToJson(row!);
    expect(restored.chaId).toBe('char-abc');
    expect(restored.name).toBe('Alice');
    expect(restored.type).toBe('character');
    expect(restored.desc).toBe('A brave adventurer');
    expect(restored.systemPrompt).toBe('You are Alice.');
    expect(restored.tags).toEqual(['fantasy', 'female']);
    expect(restored.globalLore).toEqual([{ keys: ['sword'], content: 'A magic sword', order: 1 }]);
    expect(restored.utilityBot).toBe(true);
    expect(restored.removedQuotes).toBe(false);
    expect(restored.chatPage).toBe(2);
    expect(restored.bias).toEqual([['bad', -100]]);
    expect(restored.extentions).toEqual({ custom: 'data' });
  });

  it('chats, image, emotionImages 등 제외 필드는 columns에 포함되지 않음', () => {
    const { columns } = characterJsonToColumns(original);
    expect(columns).not.toHaveProperty('chats');
    expect(columns).not.toHaveProperty('image');
    expect(columns).not.toHaveProperty('emotionImages');
  });

  it('미지의 필드가 있으면 unknownFields에 포함', () => {
    const withUnknown = { ...original, brandNewField: 'value', anotherOne: 42 };
    const { unknownFields } = characterJsonToColumns(withUnknown);
    expect(unknownFields).toContain('brandNewField');
    expect(unknownFields).toContain('anotherOne');
  });

  it('null/undefined 값도 안전하게 처리', () => {
    const sparse = { chaId: 'char-sparse', name: 'Sparse', desc: null, systemPrompt: undefined };
    const { columns } = characterJsonToColumns(sparse);
    const wsId = generateId(db);
    upsertCharacter(db, wsId, 'char-sparse', 'hash', null, columns);

    const row = getCharacterByCharId(db, 'char-sparse');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Sparse');
  });
});

// ═══════════════════════════════════════════════════════════════
// 에셋 참조 추출 + 복원
// ═══════════════════════════════════════════════════════════════

describe('asset reference round-trip', () => {
  it('emotionImages 배열 구조가 보존됨', () => {
    const charWsId = generateId(db);
    upsertCharacter(db, charWsId, 'char-1', 'h', null, { name: 'Alice' });

    // 에셋 등록
    const asset1Id = generateId(db);
    const asset2Id = generateId(db);
    upsertAsset(db, asset1Id, 'abc111', Buffer.from('img1'), 'image/png', 'assets/abc111.png');
    upsertAsset(db, asset2Id, 'abc222', Buffer.from('img2'), 'image/png', 'assets/abc222.png');

    // 매핑
    linkCharacterAsset(db, charWsId, asset1Id, 'emotionImages', 'happy', null, null, 0);
    linkCharacterAsset(db, charWsId, asset2Id, 'emotionImages', 'sad', null, null, 1);

    const map = getAssetMapByCharacter(db, charWsId);
    const emotions = map.filter((m) => m.field === 'emotionImages');
    expect(emotions).toHaveLength(2);
    expect(emotions[0].label).toBe('happy');
    expect(emotions[0].__ws_order).toBe(0);
    expect(emotions[1].label).toBe('sad');
    expect(emotions[1].__ws_order).toBe(1);
  });

  it('additionalAssets 배열 구조가 보존됨 (label + ext)', () => {
    const charWsId = generateId(db);
    upsertCharacter(db, charWsId, 'char-1', 'h', null, { name: 'Alice' });

    const assetId = generateId(db);
    upsertAsset(db, assetId, 'def333', Buffer.from('audio'), 'audio/mpeg', 'assets/def333.mp3');

    linkCharacterAsset(db, charWsId, assetId, 'additionalAssets', 'bgm_01', 'mp3', null, 0);

    const map = getAssetMapByCharacter(db, charWsId);
    const additional = map.find((m) => m.field === 'additionalAssets');
    expect(additional?.label).toBe('bgm_01');
    expect(additional?.ext).toBe('mp3');
  });

  it('ccAssets 배열 구조가 보존됨 (label + ext + cc_type)', () => {
    const charWsId = generateId(db);
    upsertCharacter(db, charWsId, 'char-1', 'h', null, { name: 'Alice' });

    const assetId = generateId(db);
    upsertAsset(db, assetId, 'ghi444', Buffer.from('icon'), 'image/png', 'assets/ghi444.png');

    linkCharacterAsset(db, charWsId, assetId, 'ccAssets', 'iconx', 'png', 'icon', 0);

    const map = getAssetMapByCharacter(db, charWsId);
    const cc = map.find((m) => m.field === 'ccAssets');
    expect(cc?.label).toBe('iconx');
    expect(cc?.ext).toBe('png');
    expect(cc?.cc_type).toBe('icon');
  });

  it('동일 에셋을 여러 캐릭터가 공유할 수 있음', () => {
    const char1 = generateId(db);
    const char2 = generateId(db);
    upsertCharacter(db, char1, 'c1', 'h', null, { name: 'A' });
    upsertCharacter(db, char2, 'c2', 'h', null, { name: 'B' });

    const assetId = generateId(db);
    upsertAsset(db, assetId, 'shared', Buffer.from('img'), 'image/png', 'assets/shared.png');

    linkCharacterAsset(db, char1, assetId, 'image', null, null, null, 0);
    linkCharacterAsset(db, char2, assetId, 'image', null, null, null, 0);

    expect(getAssetMapByCharacter(db, char1)).toHaveLength(1);
    expect(getAssetMapByCharacter(db, char2)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 채팅 정규화
// ═══════════════════════════════════════════════════════════════

describe('chat normalization round-trip', () => {
  it('채팅 세션 + 메시지가 정규화 저장되고 순서대로 복원됨', () => {
    const charWsId = generateId(db);
    upsertCharacter(db, charWsId, 'char-1', 'h', null, { name: 'Alice' });

    const sessionId = generateId(db);
    upsertChatSession(db, sessionId, charWsId, 'uuid-123', 0, {
      hypa_v2: '{}',
      hypa_v3: '{}',
      script_state: '{}',
      local_lore: '[]',
    }, 'hash1', 'coldstorage/uuid-123');

    const messages = [
      { role: 'user', data: 'Hi!', chatId: 'msg-1', time: 1000 },
      { role: 'char', data: 'Hello!', chatId: 'msg-2', time: 2000, saying: 'char-1' },
      { role: 'user', data: 'How are you?', chatId: 'msg-3', time: 3000 },
    ];
    insertChatMessages(db, sessionId, messages);

    // 복원
    const sessions = getChatSessionsByCharacter(db, charWsId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].uuid).toBe('uuid-123');

    const restored = getChatMessagesBySession(db, sessionId);
    expect(restored).toHaveLength(3);
    expect(restored[0].role).toBe('user');
    expect(restored[0].data).toBe('Hi!');
    expect(restored[0].__ws_display_order).toBe(0);
    expect(restored[1].role).toBe('char');
    expect(restored[1].saying).toBe('char-1');
    expect(restored[1].__ws_display_order).toBe(1);
    expect(restored[2].__ws_display_order).toBe(2);
  });

  it('uuid로 세션 조회 가능', () => {
    const charWsId = generateId(db);
    upsertCharacter(db, charWsId, 'char-1', 'h', null, { name: 'Alice' });

    const sessionId = generateId(db);
    upsertChatSession(db, sessionId, charWsId, 'my-uuid', 0, {}, null, null);

    const found = getChatSessionByUuid(db, 'my-uuid');
    expect(found).toBeDefined();
    expect(found?.__ws_id).toBe(sessionId);
  });

  it('메시지의 optional 필드가 보존됨', () => {
    const sessionId = generateId(db);
    const charWsId = generateId(db);
    upsertCharacter(db, charWsId, 'char-1', 'h', null, {});
    upsertChatSession(db, sessionId, charWsId, null, 0, {}, null, null);

    insertChatMessages(db, sessionId, [
      {
        role: 'char',
        data: 'Response',
        chatId: 'cid-1',
        disabled: 'allBefore',
        isComment: true,
        otherUser: false,
        generationInfo: { model: 'gpt-4', inputTokens: 100 },
        promptInfo: { promptName: 'default' },
      },
    ]);

    const msgs = getChatMessagesBySession(db, sessionId);
    expect(msgs[0].disabled).toBe('allBefore');
    expect(msgs[0].is_comment).toBe(1);
    expect(msgs[0].generation_info).toContain('gpt-4');
  });
});

// ═══════════════════════════════════════════════════════════════
// 에셋 보호 (remove-handler용)
// ═══════════════════════════════════════════════════════════════

describe('asset reference protection', () => {
  it('참조되는 에셋은 isAssetHashReferenced가 true', () => {
    const charWsId = generateId(db);
    upsertCharacter(db, charWsId, 'char-1', 'h', null, { name: 'A' });

    const assetId = generateId(db);
    upsertAsset(db, assetId, 'protected-hash', Buffer.from('img'), 'image/png', null);
    linkCharacterAsset(db, charWsId, assetId, 'image', null, null, null, 0);

    expect(isAssetHashReferenced(db, 'protected-hash')).toBe(true);
  });

  it('참조되지 않는 에셋은 false', () => {
    const assetId = generateId(db);
    upsertAsset(db, assetId, 'orphan-hash', Buffer.from('img'), 'image/png', null);

    expect(isAssetHashReferenced(db, 'orphan-hash')).toBe(false);
  });

  it('soft delete된 매핑은 참조로 안 침', () => {
    const charWsId = generateId(db);
    upsertCharacter(db, charWsId, 'char-1', 'h', null, { name: 'A' });

    const assetId = generateId(db);
    upsertAsset(db, assetId, 'was-used', Buffer.from('img'), 'image/png', null);
    linkCharacterAsset(db, charWsId, assetId, 'image', null, null, null, 0);

    expect(isAssetHashReferenced(db, 'was-used')).toBe(true);

    softDeleteAssetMapByCharacter(db, charWsId);

    expect(isAssetHashReferenced(db, 'was-used')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// soft delete cascade
// ═══════════════════════════════════════════════════════════════

describe('soft delete cascade', () => {
  it('캐릭터 soft delete 시 연관 세션, 메시지, 에셋 매핑, 블록 전부 soft delete', () => {
    const charWsId = generateId(db);
    upsertCharacter(db, charWsId, 'char-del', 'h', null, { name: 'Doomed' });

    // 채팅
    const sessionId = generateId(db);
    upsertChatSession(db, sessionId, charWsId, 'uuid-del', 0, {}, null, null);
    insertChatMessages(db, sessionId, [{ role: 'user', data: 'bye' }]);

    // 에셋
    const assetId = generateId(db);
    upsertAsset(db, assetId, 'del-hash', Buffer.from('x'), 'image/png', null);
    linkCharacterAsset(db, charWsId, assetId, 'image', null, null, null, 0);

    // 블록
    upsertBlock(db, generateId(db), 'remote:char-del', 6, 'remote:char-del', '{}', 'bh');

    // stale 판별: activeCharIds에 없으면 soft delete
    const purged = softDeleteStaleCharacters(db, new Set(['other-char']));
    expect(purged).toContain('char-del');

    // 캐릭터 조회 안 됨
    expect(getCharacterByCharId(db, 'char-del')).toBeUndefined();
    expect(getAllCharacterIds(db)).toHaveLength(0);

    // 세션 조회 안 됨
    expect(getChatSessionsByCharacter(db, charWsId)).toHaveLength(0);

    // 에셋 매핑 사라짐
    expect(getAssetMapByCharacter(db, charWsId)).toHaveLength(0);
    expect(isAssetHashReferenced(db, 'del-hash')).toBe(false);
  });

  it('activeCharIds에 있는 캐릭터는 살아남음', () => {
    const alive = generateId(db);
    const dead = generateId(db);
    upsertCharacter(db, alive, 'char-alive', 'h', null, { name: 'Survivor' });
    upsertCharacter(db, dead, 'char-dead', 'h', null, { name: 'Gone' });

    const purged = softDeleteStaleCharacters(db, new Set(['char-alive']));
    expect(purged).toEqual(['char-dead']);
    expect(getCharacterByCharId(db, 'char-alive')).toBeDefined();
    expect(getCharacterByCharId(db, 'char-dead')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// blocks
// ═══════════════════════════════════════════════════════════════

describe('blocks CRUD', () => {
  it('upsert + get + hash', () => {
    const wsId = generateId(db);
    upsertBlock(db, wsId, 'config_0', 0, 'database.bin', '{"temp":0.8}', 'hash123');

    const block = getBlockByName(db, 'config_0');
    expect(block).toBeDefined();
    expect(block?.data).toBe('{"temp":0.8}');
    expect(block?.type).toBe(0);

    expect(getBlockHash(db, 'config_0')).toBe('hash123');
  });

  it('getBlocksBySource', () => {
    upsertBlock(db, generateId(db), 'c0', 0, 'database.bin', '{}', 'h1');
    upsertBlock(db, generateId(db), 'r0', 1, 'database.bin', '{}', 'h2');

    const rows = getBlocksBySource(db, 'database.bin');
    expect(rows).toHaveLength(2);
  });

  it('blockCount는 soft delete 제외', () => {
    upsertBlock(db, generateId(db), 'b1', 0, 'database.bin', '{}', 'h');
    upsertBlock(db, generateId(db), 'b2', 0, 'database.bin', '{}', 'h');
    expect(blockCount(db)).toBe(2);

    db.prepare("UPDATE blocks SET __ws_deleted_at = datetime('now') WHERE name = 'b1'").run();
    expect(blockCount(db)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// file_list_cache
// ═══════════════════════════════════════════════════════════════

describe('file_list_cache', () => {
  it('add → get → remove', () => {
    addToFileListCache(db, 'assets/abc.png');
    addToFileListCache(db, 'remotes/char-1.local.bin');

    const files = getFileListCache(db);
    expect(files).toContain('assets/abc.png');
    expect(files).toContain('remotes/char-1.local.bin');

    removeFromFileListCache(db, 'assets/abc.png');
    expect(getFileListCache(db)).not.toContain('assets/abc.png');
  });

  it('중복 add는 무시', () => {
    addToFileListCache(db, 'same.bin');
    addToFileListCache(db, 'same.bin');

    expect(getFileListCache(db)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// transaction
// ═══════════════════════════════════════════════════════════════

describe('inTransaction', () => {
  it('에러 시 롤백', () => {
    upsertBlock(db, generateId(db), 'before', 0, 'db.bin', '{}', 'h');

    expect(() => {
      inTransaction(db, () => {
        upsertBlock(db, generateId(db), 'inside', 0, 'db.bin', '{}', 'h');
        throw new Error('rollback!');
      });
    }).toThrow('rollback!');

    expect(getBlockByName(db, 'before')).toBeDefined();
    expect(getBlockByName(db, 'inside')).toBeUndefined();
  });
});
