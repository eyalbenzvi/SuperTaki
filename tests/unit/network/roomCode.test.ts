import { describe, expect, it } from 'vitest';
import {
  ROOM_CODE_SPACE,
  buildInviteUrl,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  parseInvite,
} from '../../../src/features/game/network/roomCode.ts';

describe('room codes', () => {
  it('generates valid, varied codes', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const code = generateRoomCode();
      expect(isValidRoomCode(code)).toBe(true);
      codes.add(code);
    }
    expect(codes.size).toBeGreaterThan(190);
  });

  it('is always six digits, leading zeros included', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateRoomCode()).toMatch(/^\d{6}$/);
    }
  });

  it('draws every digit position from the whole range', () => {
    /*
     * A code built by padding a number, or by reusing one random draw, tends to
     * leave a position stuck. Six positions × ten digits over 400 codes should
     * see all sixty combinations; anything missing means the space is smaller
     * than it looks.
     */
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      [...generateRoomCode()].forEach((digit, position) => {
        seen.add(`${String(position)}:${digit}`);
      });
    }
    expect(seen.size).toBe(60);
  });

  it('offers a large enough space for private use', () => {
    expect(ROOM_CODE_SPACE).toBe(1_000_000);
  });

  it('normalises the separators people put between digit groups', () => {
    expect(normalizeRoomCode(' 482 913 ')).toBe('482913');
    expect(normalizeRoomCode('482-913')).toBe('482913');
    expect(normalizeRoomCode('482_913')).toBe('482913');
    expect(normalizeRoomCode('4 8 2 9 1 3')).toBe('482913');
  });

  it.each(['482913', '482 913', '482-913', ' 000000 '])('accepts %s', (input) => {
    expect(isValidRoomCode(input)).toBe(true);
  });

  it.each(['48291', '4829134', '', '   ', '48291a', 'TIGER-MANGO-42', '482.913', '+482913'])(
    'rejects %s',
    (input) => {
      expect(isValidRoomCode(input)).toBe(false);
    },
  );
});

describe('invite links', () => {
  const base = 'https://example.github.io/color-rush/';

  it('builds a hash-routed invite url', () => {
    expect(buildInviteUrl({ roomCode: '482913' }, base)).toBe(
      'https://example.github.io/color-rush/#/join?room=482913',
    );
  });

  it('drops any pre-existing query string', () => {
    expect(buildInviteUrl({ roomCode: '482913' }, `${base}?debug=1`)).not.toContain('debug');
  });

  it('round trips through parseInvite', () => {
    const url = buildInviteUrl({ roomCode: '482913' }, base);
    expect(parseInvite(url)).toEqual({ roomCode: '482913' });
  });

  it('ignores a stale host override left in an old link', () => {
    // Invites used to be able to name a host peer id, for a room that had moved to
    // another device. Rooms do not move, so the parameter is read as noise and the
    // code alone decides where the link goes.
    expect(parseInvite('#/join?room=482913&host=crush-482913-h2')).toEqual({ roomCode: '482913' });
  });

  it('parses a bare hash fragment', () => {
    expect(parseInvite('#/join?room=482913')).toEqual({ roomCode: '482913' });
  });

  it('parses a pasted room code', () => {
    expect(parseInvite(' 482 913 ')).toEqual({ roomCode: '482913' });
  });

  it.each([
    '',
    '   ',
    'https://example.com/',
    '#/join?room=NOPE',
    '#/join?room=48291',
    'random text',
    // A URL is only an invite if it says so; six digits inside one is not a code.
    'https://example.com/482913',
  ])('returns null for %s', (input) => {
    expect(parseInvite(input)).toBeNull();
  });
});
