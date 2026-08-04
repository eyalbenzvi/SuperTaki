import { useEffect, useState } from 'react';
import { LAST_CARD_GRACE_MS } from '../network/timing.ts';
import type { OpponentView } from '../state/selectors.ts';

/** Which set of exposed seats has already served its half second. */
const NONE = { seats: '', served: false } as const;

/**
 * Holds the "never declared!" button back for the head start a last card buys.
 *
 * The host is the authority — it refuses a catch made inside the window whatever
 * a client believes — but a button that appears and then answers "there is nobody
 * to catch" is a worse control than one that is not there yet. This is the same
 * rule, rendered.
 *
 * Timed from the moment *this* client first saw the seat come down to one card,
 * which is the host's moment plus however long the snapshot took to arrive. That
 * only ever makes the button appear later than the host would allow, never
 * earlier, so the two can disagree about the exact instant without a player ever
 * meeting a refusal. Measuring anything sharper would need the host's clock on
 * the wire, for half a second of a social rule.
 *
 * The window is held for the whole set of exposed seats rather than one each, and
 * the served flag is stored *with* the set it was measured for — which is what
 * makes a seat that leaves the set and comes back get a fresh window instead of
 * inheriting the old one. The cost is that a second seat coming down to a silent
 * last card restarts the window for both, so an existing button can blink off for
 * half a second. That needs two players to reach their last card inside the same
 * 500 ms, and it errs in the direction the rule already leans.
 */
export function useCatchGrace(opponents: readonly OpponentView[]): readonly OpponentView[] {
  const seats = opponents
    .filter((opponent) => opponent.catchable)
    .map((opponent) => opponent.id)
    .sort()
    .join(' ');
  const [grace, setGrace] = useState<{ readonly seats: string; readonly served: boolean }>(NONE);

  // Nothing else will re-render this screen when a window merely expires: the
  // table state has not changed, only the clock.
  useEffect(() => {
    if (seats === '') {
      return;
    }
    const timer = setTimeout(() => {
      setGrace({ seats, served: true });
    }, LAST_CARD_GRACE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [seats]);

  const served = grace.served && grace.seats === seats;
  return served ? opponents : opponents.map((o) => (o.catchable ? { ...o, catchable: false } : o));
}
