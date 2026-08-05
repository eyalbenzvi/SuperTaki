import { afterEach, describe, expect, it } from 'vitest';
import { runsRightwards, sweepStyle } from '../../../src/features/game/ui/sweepDirection.ts';

/**
 * The one place an RTL bug could hide without any test noticing.
 *
 * The planner emits the *rule's* direction — `1` follows the seating order — and
 * a unit test on the planner passes whichever way the animation actually travels.
 * Seating order runs left-to-right in English and right-to-left in Hebrew, which
 * is the app's default, so the visual sign has to be decided here and asserted
 * here, in both directions.
 */

afterEach(() => {
  document.documentElement.dir = 'rtl';
});

function travel(direction: 1 | -1): 'rightwards' | 'leftwards' {
  const style = sweepStyle(direction) as Record<string, string>;
  return style['--sweep-from'] === '-12px' ? 'rightwards' : 'leftwards';
}

describe('the play order on screen', () => {
  /*
   * One rule, two things drawing it: the arrow in the chip and the sweep across the
   * seats. They read this function so they cannot end up pointing opposite ways —
   * which is exactly what the old circular glyph did in Hebrew.
   */
  it('follows the seating order, which is a different way round in each language', () => {
    expect(runsRightwards(1, false)).toBe(true);
    expect(runsRightwards(-1, false)).toBe(false);
    expect(runsRightwards(1, true)).toBe(false);
    expect(runsRightwards(-1, true)).toBe(true);
  });
});

describe('sweep direction', () => {
  it('follows the seating order left-to-right in English', () => {
    document.documentElement.dir = 'ltr';
    expect(travel(1)).toBe('rightwards');
    expect(travel(-1)).toBe('leftwards');
  });

  it('follows the same seating order right-to-left in Hebrew', () => {
    document.documentElement.dir = 'rtl';
    expect(travel(1)).toBe('leftwards');
    expect(travel(-1)).toBe('rightwards');
  });

  it('always travels the full width, whichever way it goes', () => {
    for (const dir of ['ltr', 'rtl']) {
      document.documentElement.dir = dir;
      for (const direction of [1, -1] as const) {
        const style = sweepStyle(direction) as Record<string, string>;
        expect(style['--sweep-from']).not.toBe(style['--sweep-to']);
        expect([style['--sweep-from'], style['--sweep-to']].sort()).toEqual(['-12px', 'calc(100% + 12px)']);
      }
    }
  });
});
