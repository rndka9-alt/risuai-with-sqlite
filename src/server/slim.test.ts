import { describe, it, expect } from 'vitest';
import {
  slimCharacter,
  deepSlimCharacter,
  mergeCharacterDetail,
  isColdMarker,
  extractColdKey,
  COLD_STORAGE_HEADER,
  HEAVY_FIELDS,
} from './slim';

describe('isColdMarker', () => {
  it('returns true for a chat with cold marker as first message', () => {
    const chat = { message: [{ data: COLD_STORAGE_HEADER + 'some-uuid' }] };
    expect(isColdMarker(chat)).toBe(true);
  });

  it('returns false for a chat with normal messages', () => {
    const chat = { message: [{ data: 'Hello!' }] };
    expect(isColdMarker(chat)).toBe(false);
  });

  it('returns false for empty chat', () => {
    expect(isColdMarker({ message: [] })).toBe(false);
    expect(isColdMarker({})).toBe(false);
  });
});

describe('extractColdKey', () => {
  it('extracts UUID from cold marker string', () => {
    const uuid = 'test-uuid-123';
    expect(extractColdKey(COLD_STORAGE_HEADER + uuid)).toBe(uuid);
  });

  it('returns null for non-marker string', () => {
    expect(extractColdKey('normal text')).toBeNull();
  });
});

describe('slimCharacter', () => {
  it('replaces chat messages with cold markers', async () => {
    const char = {
      name: 'Alice',
      chaId: 'char-1',
      chats: [
        { message: [{ role: 'char', data: 'Hello!', time: 1000 }] },
      ],
    };

    const { slimJson, coldEntries } = await slimCharacter(JSON.stringify(char), 'char-1');
    const slim = JSON.parse(slimJson);

    expect(coldEntries).toHaveLength(1);
    expect(slim.chats[0].message[0].data).toMatch(new RegExp(`^${COLD_STORAGE_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(slim.name).toBe('Alice');
  });

  it('skips chats that are already cold-markered', async () => {
    const char = {
      chaId: 'char-1',
      chats: [
        { message: [{ role: 'char', data: COLD_STORAGE_HEADER + 'existing-uuid' }] },
      ],
    };

    const { coldEntries } = await slimCharacter(JSON.stringify(char), 'char-1');
    expect(coldEntries).toHaveLength(0);
  });

  it('skips empty chats', async () => {
    const char = { chaId: 'char-1', chats: [{ message: [] }] };
    const { coldEntries } = await slimCharacter(JSON.stringify(char), 'char-1');
    expect(coldEntries).toHaveLength(0);
  });

  it('returns original JSON if no chats array', async () => {
    const char = { chaId: 'char-1', name: 'Bob' };
    const json = JSON.stringify(char);
    const { slimJson, coldEntries } = await slimCharacter(json, 'char-1');
    expect(slimJson).toBe(json);
    expect(coldEntries).toHaveLength(0);
  });
});

describe('deepSlimCharacter', () => {
  it('strips heavy fields and adds __strippedFields marker', () => {
    const char = {
      name: 'Alice',
      chaId: 'char-1',
      desc: 'A character description',
      systemPrompt: 'You are Alice',
      globalLore: [{ key: 'test', content: 'lore' }],
      tags: ['tag1'],
    };

    const { slimJson, detailJson } = deepSlimCharacter(JSON.stringify(char));
    const slim = JSON.parse(slimJson);
    const detail = JSON.parse(detailJson);

    // Heavy fields are emptied
    expect(slim.desc).toBe('');
    expect(slim.systemPrompt).toBe('');
    expect(slim.globalLore).toEqual([]);

    // Non-heavy fields preserved
    expect(slim.name).toBe('Alice');
    expect(slim.chaId).toBe('char-1');
    expect(slim.tags).toEqual(['tag1']);

    // Marker present
    expect(slim.__strippedFields).toContain('desc');
    expect(slim.__strippedFields).toContain('systemPrompt');
    expect(slim.__strippedFields).toContain('globalLore');

    // Detail has original values
    expect(detail.desc).toBe('A character description');
    expect(detail.systemPrompt).toBe('You are Alice');
    expect(detail.globalLore).toEqual([{ key: 'test', content: 'lore' }]);
  });

  it('handles object-type heavy fields', () => {
    const char = {
      chaId: 'char-1',
      depth_prompt: { depth: 4, prompt: 'deep' },
      newGenData: { prompt: 'gen', negative: 'neg' },
    };

    const { slimJson } = deepSlimCharacter(JSON.stringify(char));
    const slim = JSON.parse(slimJson);

    expect(slim.depth_prompt).toEqual({});
    expect(slim.newGenData).toEqual({});
  });

  it('does not add marker when no heavy fields exist', () => {
    const char = { name: 'Minimal', chaId: 'char-1', tags: [] };
    const { slimJson } = deepSlimCharacter(JSON.stringify(char));
    const slim = JSON.parse(slimJson);
    expect(slim.__strippedFields).toBeUndefined();
  });

  it('skips undefined heavy fields', () => {
    const char = { chaId: 'char-1', desc: 'yes', firstMessage: undefined };
    const { slimJson } = deepSlimCharacter(JSON.stringify(char));
    const slim = JSON.parse(slimJson);
    // firstMessage is undefined → skipped, not in strippedFields
    expect(slim.__strippedFields).not.toContain('firstMessage');
    expect(slim.__strippedFields).toContain('desc');
  });
});

describe('mergeCharacterDetail', () => {
  it('restores stripped fields and removes marker', () => {
    const slim = {
      name: 'Alice',
      desc: '',
      systemPrompt: '',
      __strippedFields: ['desc', 'systemPrompt'],
    };
    const detail = {
      desc: 'A character',
      systemPrompt: 'You are Alice',
    };

    const merged = JSON.parse(mergeCharacterDetail(JSON.stringify(slim), JSON.stringify(detail)));

    expect(merged.desc).toBe('A character');
    expect(merged.systemPrompt).toBe('You are Alice');
    expect(merged.name).toBe('Alice');
    expect(merged.__strippedFields).toBeUndefined();
  });

  it('returns original JSON if no __strippedFields', () => {
    const char = { name: 'Bob', desc: 'original' };
    const json = JSON.stringify(char);
    expect(mergeCharacterDetail(json, '{}')).toBe(json);
  });

  it('handles missing detail fields gracefully', () => {
    const slim = {
      desc: '',
      __strippedFields: ['desc', 'nonexistent'],
    };
    const detail = { desc: 'restored' };

    const merged = JSON.parse(mergeCharacterDetail(JSON.stringify(slim), JSON.stringify(detail)));
    expect(merged.desc).toBe('restored');
    // nonexistent stays as-is (not in detail)
  });
});

describe('HEAVY_FIELDS', () => {
  it('does not include landing-page fields', () => {
    const landingFields = ['name', 'image', 'type', 'chaId', 'creatorNotes', 'trashTime', 'tags', 'creator'];
    for (const field of landingFields) {
      expect(HEAVY_FIELDS).not.toContain(field);
    }
  });

  it('includes all expected heavy fields', () => {
    const expectedHeavy = ['desc', 'systemPrompt', 'globalLore', 'firstMessage', 'personality', 'scenario'];
    for (const field of expectedHeavy) {
      expect(HEAVY_FIELDS).toContain(field);
    }
  });
});
