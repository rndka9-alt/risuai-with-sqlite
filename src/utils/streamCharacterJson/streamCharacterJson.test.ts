import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import crypto from 'crypto';
import { streamCharacterJson } from './streamCharacterJson';

function toStream(json: string): Readable {
  return Readable.from(Buffer.from(json, 'utf-8'));
}

function expectedHash(json: string): string {
  return crypto.createHash('sha256').update(json, 'utf-8').digest('hex');
}

describe('streamCharacterJson', () => {
  it('extracts top-level scalar fields', async () => {
    const json = JSON.stringify({
      type: 'character',
      name: 'Aria',
      desc: 'A brave warrior',
      chats: [],
    });

    const { fields, hash } = await streamCharacterJson(toStream(json), () => {});

    expect(fields.type).toBe('character');
    expect(fields.name).toBe('Aria');
    expect(fields.desc).toBe('A brave warrior');
    expect(hash).toBe(expectedHash(json));
  });

  it('extracts top-level array/object fields (non-chats)', async () => {
    const json = JSON.stringify({
      name: 'Test',
      globalLore: [{ key: 'k1', content: 'lore text' }],
      tags: ['fantasy', 'adventure'],
      chats: [],
    });

    const { fields } = await streamCharacterJson(toStream(json), () => {});

    expect(fields.globalLore).toEqual([{ key: 'k1', content: 'lore text' }]);
    expect(fields.tags).toEqual(['fantasy', 'adventure']);
  });

  it('streams each chat individually via callback', async () => {
    const chat0 = { message: [{ role: 'user', data: 'hello' }], note: 'n0' };
    const chat1 = { message: [{ role: 'char', data: 'hi' }], note: 'n1' };
    const json = JSON.stringify({
      name: 'Test',
      chats: [chat0, chat1],
    });

    const receivedChats: Array<{ index: number; chat: Record<string, unknown> }> = [];
    await streamCharacterJson(toStream(json), (index, chat) => {
      receivedChats.push({ index, chat });
    });

    expect(receivedChats).toHaveLength(2);
    expect(receivedChats[0].index).toBe(0);
    expect(receivedChats[0].chat).toEqual(chat0);
    expect(receivedChats[1].index).toBe(1);
    expect(receivedChats[1].chat).toEqual(chat1);
  });

  it('chats are NOT included in fields', async () => {
    const json = JSON.stringify({
      name: 'Test',
      chats: [{ message: [] }],
      desc: 'after chats',
    });

    const { fields } = await streamCharacterJson(toStream(json), () => {});

    expect(fields).not.toHaveProperty('chats');
    expect(fields.name).toBe('Test');
    expect(fields.desc).toBe('after chats');
  });

  it('handles empty chats array', async () => {
    const json = JSON.stringify({ name: 'Test', chats: [] });

    const chats: unknown[] = [];
    const { fields } = await streamCharacterJson(toStream(json), (_, c) => chats.push(c));

    expect(chats).toHaveLength(0);
    expect(fields.name).toBe('Test');
  });

  it('handles character with no chats field', async () => {
    const json = JSON.stringify({ name: 'NoChatChar', desc: 'no chats at all' });

    const chats: unknown[] = [];
    const { fields } = await streamCharacterJson(toStream(json), (_, c) => chats.push(c));

    expect(chats).toHaveLength(0);
    expect(fields.name).toBe('NoChatChar');
    expect(fields.desc).toBe('no chats at all');
  });

  it('preserves fields that come after chats', async () => {
    const json = JSON.stringify({
      name: 'Before',
      chats: [{ message: [] }],
      personality: 'After chats field',
      scenario: 'Also after',
    });

    const { fields } = await streamCharacterJson(toStream(json), () => {});

    expect(fields.name).toBe('Before');
    expect(fields.personality).toBe('After chats field');
    expect(fields.scenario).toBe('Also after');
  });

  it('handles nested objects within chat messages', async () => {
    const chat = {
      message: [
        { role: 'user', data: 'test', generationInfo: { model: 'gpt-4', tokens: 100 } },
      ],
      scriptstate: { key: { nested: true } },
    };
    const json = JSON.stringify({ name: 'Test', chats: [chat] });

    const received: Record<string, unknown>[] = [];
    await streamCharacterJson(toStream(json), (_, c) => received.push(c));

    expect(received[0]).toEqual(chat);
  });

  it('computes correct SHA-256 hash', async () => {
    const json = JSON.stringify({
      name: 'HashTest',
      chats: [{ message: [{ role: 'user', data: 'x'.repeat(10000) }] }],
      desc: 'y'.repeat(5000),
    });

    const { hash } = await streamCharacterJson(toStream(json), () => {});

    expect(hash).toBe(expectedHash(json));
  });

  it('handles special characters and escapes in strings', async () => {
    const json = JSON.stringify({
      name: 'Quotes "and" \\backslash',
      desc: 'Unicode: 한글 テスト 🎮',
      chats: [{ message: [{ role: 'user', data: 'line1\nline2\ttab' }] }],
    });

    const received: Record<string, unknown>[] = [];
    const { fields } = await streamCharacterJson(toStream(json), (_, c) => received.push(c));

    expect(fields.name).toBe('Quotes "and" \\backslash');
    expect(fields.desc).toBe('Unicode: 한글 テスト 🎮');
    expect(received[0].message).toEqual([{ role: 'user', data: 'line1\nline2\ttab' }]);
  });

  it('handles large number of chats without accumulating', async () => {
    const chats = Array.from({ length: 100 }, (_, i) => ({
      message: [{ role: 'user', data: `msg-${i}` }],
    }));
    const json = JSON.stringify({ name: 'Bulk', chats });

    let count = 0;
    await streamCharacterJson(toStream(json), () => { count++; });

    expect(count).toBe(100);
  });
});
