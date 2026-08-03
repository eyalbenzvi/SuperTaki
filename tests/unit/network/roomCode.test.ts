import { describe, expect, it } from 'vitest';
import {
  ROOM_CODE_SPACE,
  buildInviteUrl,
  generateRoomCode,
  hostPeerIdForRoom,
  isValidPeerId,
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
    expect(codes.size).toBeGreaterThan(150);
  });

  it('never repeats the same word twice in one code', () => {
    for (let i = 0; i < 200; i += 1) {
      const [first, second] = generateRoomCode().split('-');
      expect(first).not.toBe(second);
    }
  });

  it('offers a large enough space for private use', () => {
    expect(ROOM_CODE_SPACE).toBeGreaterThan(100_000);
  });

  it('normalises sloppy input', () => {
    expect(normalizeRoomCode(' tiger mango 42 ')).toBe('TIGER-MANGO-42');
    expect(normalizeRoomCode('tiger_mango_42')).toBe('TIGER-MANGO-42');
    expect(normalizeRoomCode('--TIGER--MANGO--42--')).toBe('TIGER-MANGO-42');
  });

  it.each(['TIGER-MANGO-42', 'tiger-mango-42', 'Tiger Mango 42'])('accepts %s', (input) => {
    expect(isValidRoomCode(input)).toBe(true);
  });

  it.each(['TIGER-MANGO', 'TIGER-MANGO-4', 'TIGER-MANGO-423', '12-34-56', '', 'A-B-12'])(
    'rejects %s',
    (input) => {
      expect(isValidRoomCode(input)).toBe(false);
    },
  );

  it('derives a stable, PeerJS-safe host id', () => {
    expect(hostPeerIdForRoom('TIGER-MANGO-42')).toBe('crush-tiger-mango-42');
    expect(hostPeerIdForRoom('tiger mango 42')).toBe('crush-tiger-mango-42');
    expect(isValidPeerId(hostPeerIdForRoom(generateRoomCode()))).toBe(true);
  });

  it('validates peer ids', () => {
    expect(isValidPeerId('crush-tiger-mango-42')).toBe(true);
    expect(isValidPeerId('abc_123')).toBe(true);
    expect(isValidPeerId('')).toBe(false);
    expect(isValidPeerId('has space')).toBe(false);
    expect(isValidPeerId('bad!char')).toBe(false);
    expect(isValidPeerId('x'.repeat(65))).toBe(false);
  });
});

describe('invite links', () => {
  const base = 'https://example.github.io/color-rush/';

  it('builds a hash-routed invite url', () => {
    expect(buildInviteUrl({ roomCode: 'TIGER-MANGO-42' }, base)).toBe(
      'https://example.github.io/color-rush/#/join?room=TIGER-MANGO-42',
    );
  });

  it('drops any pre-existing query string', () => {
    expect(buildInviteUrl({ roomCode: 'TIGER-MANGO-42' }, `${base}?debug=1`)).not.toContain('debug');
  });

  it('includes a non-derived host id only when needed', () => {
    expect(
      buildInviteUrl({ roomCode: 'TIGER-MANGO-42', hostPeerId: 'crush-tiger-mango-42' }, base),
    ).not.toContain('host=');
    expect(buildInviteUrl({ roomCode: 'TIGER-MANGO-42', hostPeerId: 'custom-host-1' }, base)).toContain(
      'host=custom-host-1',
    );
  });

  it('round trips through parseInvite', () => {
    const url = buildInviteUrl({ roomCode: 'TIGER-MANGO-42', hostPeerId: 'custom-host-1' }, base);
    expect(parseInvite(url)).toEqual({ roomCode: 'TIGER-MANGO-42', hostPeerId: 'custom-host-1' });
  });

  it('parses a bare hash fragment', () => {
    expect(parseInvite('#/join?room=tiger-mango-42')).toEqual({ roomCode: 'TIGER-MANGO-42' });
  });

  it('parses a pasted room code', () => {
    expect(parseInvite(' tiger mango 42 ')).toEqual({ roomCode: 'TIGER-MANGO-42' });
  });

  it('ignores an invalid host override', () => {
    expect(parseInvite('#/join?room=TIGER-MANGO-42&host=bad%20id')).toEqual({
      roomCode: 'TIGER-MANGO-42',
    });
  });

  it.each(['', '   ', 'https://example.com/', '#/join?room=NOPE', 'random text'])(
    'returns null for %s',
    (input) => {
      expect(parseInvite(input)).toBeNull();
    },
  );
});
