import { DEFAULT_LANGUAGE, isLanguage, type Language } from '../../../i18n/index.ts';
import { sanitizeDisplayName } from '../../../lib/sanitize.ts';
import { STORAGE_KEYS, readJson, readRaw, removeRaw, writeJson, writeRaw } from '../../../lib/storage.ts';
import { isValidPeerId, isValidRoomCode } from '../network/roomCode.ts';

/**
 * The only things this app persists locally:
 * display preferences, the player's chosen name, and a short-lived token that
 * lets them re-take their seat after a refresh. No game history, no identifiers
 * shared with anyone but the room's host.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

const THEMES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

/** Resume metadata expires so a stale token never lingers on a shared device. */
export const RESUME_TTL_MS = 6 * 60 * 60 * 1000;

export interface ResumableRoom {
  readonly roomCode: string;
  readonly hostPeerId: string;
  readonly playerId: string;
  readonly resumeToken: string;
  readonly displayName: string;
  readonly savedAt: number;
  /** Host generation this credential was last seen at, so a handover can be followed. */
  readonly generation?: number;
}

export function loadLanguage(): Language {
  const stored = readRaw(STORAGE_KEYS.language);
  return isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
}

export function saveLanguage(language: Language): void {
  writeRaw(STORAGE_KEYS.language, language);
}

export function loadTheme(): ThemeChoice {
  const stored = readRaw(STORAGE_KEYS.theme);
  return THEMES.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : 'system';
}

export function saveTheme(theme: ThemeChoice): void {
  writeRaw(STORAGE_KEYS.theme, theme);
}

export function loadDisplayName(): string {
  return sanitizeDisplayName(readRaw(STORAGE_KEYS.displayName));
}

export function saveDisplayName(name: string): void {
  const cleaned = sanitizeDisplayName(name);
  if (cleaned.length > 0) {
    writeRaw(STORAGE_KEYS.displayName, cleaned);
  }
}

function validateResumable(value: unknown, now: number): ResumableRoom | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Partial<ResumableRoom>;
  if (
    typeof candidate.roomCode !== 'string' ||
    typeof candidate.hostPeerId !== 'string' ||
    typeof candidate.playerId !== 'string' ||
    typeof candidate.resumeToken !== 'string' ||
    typeof candidate.displayName !== 'string' ||
    typeof candidate.savedAt !== 'number'
  ) {
    return null;
  }
  if (!isValidRoomCode(candidate.roomCode) || !isValidPeerId(candidate.hostPeerId)) {
    return null;
  }
  if (candidate.resumeToken.length < 8 || candidate.resumeToken.length > 64) {
    return null;
  }
  if (now - candidate.savedAt > RESUME_TTL_MS || candidate.savedAt > now + 60_000) {
    return null;
  }
  return {
    roomCode: candidate.roomCode,
    hostPeerId: candidate.hostPeerId,
    playerId: candidate.playerId,
    resumeToken: candidate.resumeToken,
    displayName: sanitizeDisplayName(candidate.displayName) || 'Player',
    savedAt: candidate.savedAt,
    ...(typeof candidate.generation === 'number' && candidate.generation >= 0
      ? { generation: candidate.generation }
      : {}),
  };
}

export function loadResumableRoom(now: number = Date.now()): ResumableRoom | null {
  return readJson(STORAGE_KEYS.resumableRoom, (value) => validateResumable(value, now));
}

export function saveResumableRoom(room: Omit<ResumableRoom, 'savedAt'>, now: number = Date.now()): void {
  writeJson(STORAGE_KEYS.resumableRoom, { ...room, savedAt: now });
}

export function clearResumableRoom(): void {
  removeRaw(STORAGE_KEYS.resumableRoom);
}

/** Applies the theme choice to the document root; returns the resolved theme. */
export function applyTheme(theme: ThemeChoice): 'light' | 'dark' {
  const prefersDark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false;
  const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }
  return resolved;
}

/** Applies language direction to the document root. */
export function applyLanguage(language: Language, direction: 'rtl' | 'ltr'): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language;
    document.documentElement.dir = direction;
  }
}
