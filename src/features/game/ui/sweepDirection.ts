import type { CSSProperties } from 'react';

/**
 * Which way the play order runs *on screen*.
 *
 * `1` means "follows the seating order", and the seats are laid out in the
 * document's direction — left-to-right in English, right-to-left in Hebrew. So the
 * rule's sign is not a visual one until a text direction has been applied to it,
 * and everything that draws the order has to apply the same one: an arrow and a
 * sweep that disagree tell one table two different things while every unit test
 * passes.
 */
export function runsRightwards(direction: 1 | -1, rtl: boolean): boolean {
  return rtl ? direction === -1 : direction === 1;
}

/**
 * Turns the rule's direction into a visual one for the sweep across the seats.
 *
 * Deciding it here, rather than where the motion is planned, is what stops the
 * sweep running backwards in the app's default language while a unit test reports
 * it correct.
 */
export function sweepStyle(direction: 1 | -1): CSSProperties {
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const rightwards = runsRightwards(direction, rtl);
  return {
    '--sweep-from': rightwards ? '-12px' : 'calc(100% + 12px)',
    '--sweep-to': rightwards ? 'calc(100% + 12px)' : '-12px',
  } as CSSProperties;
}
