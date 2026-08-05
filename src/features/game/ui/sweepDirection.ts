import type { CSSProperties } from 'react';

/**
 * Turns the rule's direction into a visual one.
 *
 * `1` means "follows the seating order", which is left-to-right in English and
 * right-to-left in Hebrew — so the sign cannot be decided where the motion is
 * planned. Deciding it here is what stops the sweep running backwards in the
 * app's default language while a unit test reports it correct.
 */
export function sweepStyle(direction: 1 | -1): CSSProperties {
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const forward = rtl ? direction === -1 : direction === 1;
  return {
    '--sweep-from': forward ? '-12px' : 'calc(100% + 12px)',
    '--sweep-to': forward ? 'calc(100% + 12px)' : '-12px',
  } as CSSProperties;
}
