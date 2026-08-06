import { describe, expect, it } from 'vitest';
import { robotName } from '../../../src/features/game/bot/names.ts';
import { DISPLAY_NAME_MAX_LENGTH, isValidDisplayName } from '../../../src/lib/sanitize.ts';

/**
 * A robot is named after what it is.
 *
 * The pool of human first names that used to live here read as a person in the feed,
 * which is precisely the one thing a name at this table must not do.
 */
describe('robot names', () => {
  it('numbers robots in the table language', () => {
    expect(robotName('he', [])).toBe('רובוט 1');
    expect(robotName('he', ['דנה', 'רובוט 1'])).toBe('רובוט 2');
    expect(robotName('en', [])).toBe('Robot 1');
    expect(robotName('en', ['Dana', 'Robot 1', 'Robot 2'])).toBe('Robot 3');
  });

  it('reuses the number a removed robot gave back', () => {
    // Adding, removing and adding again should not climb: the seat that comes back
    // is "Robot 1" because that is the lowest number this table is not using.
    expect(robotName('he', ['דנה', 'רובוט 2'])).toBe('רובוט 1');
  });

  it('does not take a name a person is already using', () => {
    expect(robotName('en', ['Robot 1'])).toBe('Robot 2');
    expect(robotName('en', ['robot 1'])).toBe('Robot 2');
  });

  it('produces a name the wire accepts', () => {
    for (let seated = 0; seated < 6; seated += 1) {
      const taken = Array.from({ length: seated }, (_, index) => `Robot ${String(index + 1)}`);
      const name = robotName('en', taken);
      expect(isValidDisplayName(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH);
      expect(taken).not.toContain(name);
    }
  });
});
