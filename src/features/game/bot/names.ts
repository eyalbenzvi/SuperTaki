import { sanitizeDisplayName, uniquifyDisplayName } from '../../../lib/sanitize.ts';

/**
 * What a robot is called.
 *
 * Names, not numbers: "רובוט תמר" reads as somebody at the table, and the log
 * lines a robot produces are the same lines a player's moves produce. They are
 * written in the table's language because that is the language the room is playing
 * in, and they go through the same sanitising and uniquifying as any human name —
 * so a robot cannot end up with a name the wire would refuse, and two robots are
 * never confusable in the feed.
 *
 * They stay short deliberately: `DISPLAY_NAME_MAX_LENGTH` is 16, and a name that
 * is truncated mid-word looks like a bug.
 */
const POOL: Readonly<Record<'he' | 'en', readonly string[]>> = {
  he: ['רובוט תמר', 'רובוט ארז', 'רובוט רימון', 'רובוט אלון', 'רובוט זית'],
  en: ['Robot Fern', 'Robot Cedar', 'Robot Poppy', 'Robot Alder', 'Robot Olive'],
};

/** The first unused robot name for this table, made unique against the seats taken. */
export function robotName(language: 'he' | 'en', taken: readonly string[]): string {
  const pool = POOL[language];
  const used = new Set(taken.map((name) => name.toLocaleLowerCase()));
  const free = pool.find((name) => !used.has(name.toLocaleLowerCase())) ?? pool[0];
  return uniquifyDisplayName(sanitizeDisplayName(free), taken);
}
