import { parseInvite, type InviteDetails } from '../features/game/network/roomCode.ts';
import type { Screen } from '../features/game/state/store.ts';

/**
 * Minimal hash-based routing.
 *
 * GitHub Pages cannot rewrite unknown paths to `index.html`, so deep links must
 * live in the fragment. Only two routes need to be addressable: the join flow
 * (invite links) and the rules page.
 */
export function screenFromHash(hash: string): Screen | null {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  if (path === 'join') {
    return 'join';
  }
  if (path === 'rules') {
    return 'rules';
  }
  return null;
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
