import { parseInvite, type InviteDetails } from '../features/game/network/roomCode.ts';
import type { Screen } from '../features/game/state/store.ts';

/**
 * Minimal hash-based routing.
 *
 * GitHub Pages cannot rewrite unknown paths to `index.html`, so deep links must
 * live in the fragment. Only one route needs to be addressable: the join flow
 * behind an invite link.
 */
export function screenFromHash(hash: string): Screen | null {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  return path === 'join' ? 'join' : null;
}

export function inviteFromHash(hash: string): InviteDetails | null {
  return screenFromHash(hash) === 'join' ? parseInvite(hash) : null;
}

/** Removes the invite parameters once they have been consumed. */
export function clearHash(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const { pathname, search } = window.location;
  window.history.replaceState(null, '', `${pathname}${search}`);
}
