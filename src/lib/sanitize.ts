/**
 * Input hygiene for the few strings that travel between peers.
 *
 * React escapes text nodes for us and the app never uses
 * `dangerouslySetInnerHTML`, so this is about keeping names readable and
 * bounded rather than about HTML escaping.
 */

export const DISPLAY_NAME_MAX_LENGTH = 16;
export const DISPLAY_NAME_MIN_LENGTH = 1;

/**
 * Characters removed from display names: C0/C1 controls, bidi overrides and
 * embeddings, zero-width marks, and the byte-order mark. These are invisible or
 * layout-altering and are a common way to spoof another player's name.
 */
const UNSAFE_CHARACTERS = new RegExp(
  '[' +
    '\\u0000-\\u001F' +
    '\\u007F-\\u009F' +
    '\\u200B-\\u200F' +
    '\\u202A-\\u202E' +
    '\\u2060-\\u206F' +
    '\\uFEFF' +
    ']',
  'gu',
);

/**
 * Normalises a display name: strips unsafe characters, collapses whitespace and
 * truncates. Returns an empty string when nothing usable remains.
 */
export function sanitizeDisplayName(input: unknown): string {
  if (typeof input !== 'string') {
    return '';
  }
  return input
    .normalize('NFC')
    .replace(UNSAFE_CHARACTERS, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, DISPLAY_NAME_MAX_LENGTH);
}

export function isValidDisplayName(input: unknown): boolean {
  const cleaned = sanitizeDisplayName(input);
  return cleaned.length >= DISPLAY_NAME_MIN_LENGTH && cleaned.length <= DISPLAY_NAME_MAX_LENGTH;
}

/**
 * Makes a name unique inside a room by appending a counter, so two players
 * called "Dana" stay distinguishable in the event feed.
 */
export function uniquifyDisplayName(name: string, taken: readonly string[]): string {
  const existing = new Set(taken.map((value) => value.toLocaleLowerCase()));
  if (!existing.has(name.toLocaleLowerCase())) {
    return name;
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${name.slice(0, DISPLAY_NAME_MAX_LENGTH - 2)} ${suffix}`;
    if (!existing.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }
  return name;
}
