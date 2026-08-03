import type { ReactNode } from 'react';
import { useAppStore } from '../features/game/state/store.ts';

/**
 * The app's single polite live region.
 *
 * Game events used to be announced by putting `aria-live` on the log list,
 * which meant a screen reader read every line of a scrolling history and read
 * the turn banner again on top of it. One region, one message at a time, is both
 * quieter and more useful: the caller decides what is worth saying.
 *
 * Rejected moves are deliberately not routed here — they are an `alert`
 * elsewhere, because a move that did not happen must interrupt.
 */
export function Announcer(): ReactNode {
  const announcement = useAppStore((state) => state.announcement);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement?.text ?? ''}
    </div>
  );
}
