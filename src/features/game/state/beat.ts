import type { GameEvent } from '../engine/state.ts';

/**
 * One accepted command, as the presentation layer needs to see it.
 *
 * A move reaches a client as three separate writes — the public state, then the
 * hand, then the events — and the events are last. Publishing the beat when they
 * land is what gives a cue one place to ask "what just happened", instead of
 * inferring it from a state diff that has already been applied.
 *
 * It carries no authority and nothing that is not already in `publicState`,
 * `hand` and `feed`. Discard it and the game is unchanged; only the table goes
 * quiet.
 *
 * There is deliberately no local-or-remote flag. Matching the outstanding request
 * id does not work: a catch draws my penalty and emits a `cardDrawn` that is mine
 * without the move being mine, and the action lock can clear before the answer
 * arrives. Where the distinction is needed it comes from the event's own
 * `playerId`; where it exists only to stop a card being animated twice, the
 * flight layer's in-flight registry answers it directly.
 *
 * It carries no table signature either, and that is a correction rather than an
 * omission. The design called for the table before and after the command so that
 * motion could be derived from the difference. Nothing ever needed it: positions
 * come from the live DOM, which is the truth rather than a reconstruction of it,
 * and every cue is keyed on the events. Keeping the signature meant walking every
 * seat and every card in hand on every move to build something no one read.
 */
export interface Beat {
  /** Monotonic across the session's life, like the feed's ids. */
  readonly seq: number;
  readonly events: readonly GameEvent[];
}
