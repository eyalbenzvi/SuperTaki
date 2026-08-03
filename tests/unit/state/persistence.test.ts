import { describe, expect, it } from 'vitest';
import {
  RESUME_TTL_MS,
  applyLanguage,
  applyTheme,
  clearResumableRoom,
  loadDisplayName,
  loadLanguage,
  loadResumableRoom,
  loadTheme,
  saveDisplayName,
  saveLanguage,
  saveResumableRoom,
  saveTheme,
} from '../../../src/features/game/state/persistence.ts';
import { writeRaw } from '../../../src/lib/storage.ts';

const NOW = 1_700_000_000_000;

const validRoom = {
  roomCode: 'TIGER-MANGO-42',
  hostPeerId: 'crush-tiger-mango-42',
  playerId: 'pl_abc',
  resumeToken: 'a'.repeat(32),
  displayName: 'Dana',
};

describe('preferences', () => {
  it('defaults to Hebrew and the system theme', () => {
    expect(loadLanguage()).toBe('he');
    expect(loadTheme()).toBe('system');
  });

  it('round trips the language', () => {
    saveLanguage('en');
    expect(loadLanguage()).toBe('en');
  });

  it('ignores an unknown stored language or theme', () => {
    writeRaw('language', 'klingon');
    writeRaw('theme', 'neon');
    expect(loadLanguage()).toBe('he');
    expect(loadTheme()).toBe('system');
  });

  it('round trips the theme', () => {
    saveTheme('dark');
    expect(loadTheme()).toBe('dark');
  });

  it('stores a sanitised display name and ignores an empty one', () => {
    saveDisplayName('  Dana  ');
    expect(loadDisplayName()).toBe('Dana');
    saveDisplayName('   ');
    expect(loadDisplayName()).toBe('Dana');
  });
});

describe('resumable room metadata', () => {
  it('round trips a valid entry', () => {
    saveResumableRoom(validRoom, NOW);
    expect(loadResumableRoom(NOW)).toEqual({ ...validRoom, savedAt: NOW });
  });

  it('expires after the TTL', () => {
    saveResumableRoom(validRoom, NOW);
    expect(loadResumableRoom(NOW + RESUME_TTL_MS + 1)).toBeNull();
    // ...and the stale entry is removed rather than left behind.
    expect(loadResumableRoom(NOW)).toBeNull();
  });

  it('rejects a timestamp from the future', () => {
    saveResumableRoom(validRoom, NOW + 10 * 60_000);
    expect(loadResumableRoom(NOW)).toBeNull();
  });

  it.each([
    ['a missing field', { ...validRoom, playerId: undefined }],
    ['a malformed room code', { ...validRoom, roomCode: 'nope' }],
    ['an unusable peer id', { ...validRoom, hostPeerId: 'bad id!' }],
    ['a too-short token', { ...validRoom, resumeToken: 'abc' }],
    ['a wrong type', { ...validRoom, savedAt: 'yesterday' }],
    ['a non-object', 'nonsense'],
  ])('rejects %s', (_label, value) => {
    writeRaw('resumableRoom', JSON.stringify(value));
    expect(loadResumableRoom(NOW)).toBeNull();
  });

  it('can be cleared', () => {
    saveResumableRoom(validRoom, NOW);
    clearResumableRoom();
    expect(loadResumableRoom(NOW)).toBeNull();
  });

  it('never stores anything beyond the documented fields', () => {
    saveResumableRoom(validRoom, NOW);
    const raw = localStorage.getItem('colorRush:resumableRoom') ?? '{}';
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      'displayName',
      'hostPeerId',
      'playerId',
      'resumeToken',
      'roomCode',
      'savedAt',
    ]);
  });
});

describe('applying appearance to the document', () => {
  it('resolves the system theme through matchMedia', () => {
    expect(applyTheme('dark')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    expect(applyTheme('light')).toBe('light');
    // jsdom's stub reports "no preference", so system resolves to light.
    expect(applyTheme('system')).toBe('light');
  });

  it('sets language and direction on the root element', () => {
    applyLanguage('en', 'ltr');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');

    applyLanguage('he', 'rtl');
    expect(document.documentElement.dir).toBe('rtl');
  });
});
