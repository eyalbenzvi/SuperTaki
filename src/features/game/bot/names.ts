import { sanitizeDisplayName, uniquifyDisplayName } from '../../../lib/sanitize.ts';

/**
 * What a robot is called: "Robot 1", "Robot 2", and so on.
 *
 * Numbers, not names. A pool of human first names ("רובוט תמר") was here first, on the
 * argument that it reads as somebody at the table — but that is exactly the problem. The
 * one thing a player has to know about a seat is whether a person is behind it, and a
 * given name works against that reading every time it appears in the feed. A number says
 * what the seat is and tells two robots apart in the same breath.
 *
 * The number is the lowest one free at this table rather than a running count, so
 * removing "Robot 1" and adding another gets "Robot 1" back instead of climbing for ever.
 * The comparison is against every seat, human seats included: a player who has called
 * themselves "Robot 2" takes that name out of circulation rather than ending up sharing
 * it. The result still goes through the same sanitising and uniquifying as any human
 * name, so a robot cannot hold a name the wire would refuse.
 *
 * They are written in the table's language because that is the language the room plays
 * in, and they stay short: `DISPLAY_NAME_MAX_LENGTH` is 16, and a name truncated
 * mid-word looks like a bug.
 */
const PREFIX: Readonly<Record<'he' | 'en', string>> = {
  he: 'רובוט',
  en: 'Robot',
};

/** The lowest-numbered robot name this table is not already using. */
export function robotName(language: 'he' | 'en', taken: readonly string[]): string {
  const prefix = PREFIX[language];
  const used = new Set(taken.map((name) => name.toLocaleLowerCase()));
  let number = 1;
  while (used.has(`${prefix} ${String(number)}`.toLocaleLowerCase())) {
    number += 1;
  }
  return uniquifyDisplayName(sanitizeDisplayName(`${prefix} ${String(number)}`), taken);
}
