/**
 * Namespaced, failure-tolerant localStorage access.
 *
 * Storage can throw (Safari private mode, disabled cookies, quota) and the app
 * must keep working without it, so every operation degrades to a no-op.
 */

const PREFIX = 'superTaki:';

export function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    /* storage unavailable — preferences simply do not persist */
  }
}

export function removeRaw(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Reads and validates JSON, removing the entry when it cannot be trusted. */
export function readJson<T>(key: string, validate: (value: unknown) => T | null): T | null {
  const raw = readRaw(key);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = validate(parsed);
    if (validated === null) {
      removeRaw(key);
    }
    return validated;
  } catch {
    removeRaw(key);
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    writeRaw(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/*
 * Session-scoped variants.
 *
 * `sessionStorage` survives a reload and dies with the tab, which is exactly the
 * right lifetime for a host's game state: a reload is the common accident worth
 * recovering from, and the snapshot contains every player's hand and the order of
 * the deck, so it has no business outliving the tab that needed it. See
 * docs/threat-model.md.
 */

export function readSessionRaw(key: string): string | null {
  try {
    return window.sessionStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeSessionRaw(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(PREFIX + key, value);
  } catch {
    /* quota or private mode: recovery is best-effort by design */
  }
}

export function removeSessionRaw(key: string): void {
  try {
    window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

export function readSessionJson<T>(key: string, validate: (value: unknown) => T | null): T | null {
  const raw = readSessionRaw(key);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = validate(parsed);
    if (validated === null) {
      removeSessionRaw(key);
    }
    return validated;
  } catch {
    removeSessionRaw(key);
    return null;
  }
}

export function writeSessionJson(key: string, value: unknown): void {
  try {
    writeSessionRaw(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const STORAGE_KEYS = {
  language: 'language',
  theme: 'theme',
  sound: 'sound',
  displayName: 'displayName',
  identity: 'identity',
  resumableRoom: 'resumableRoom',
  hostedRoom: 'hostedRoom',
} as const;
