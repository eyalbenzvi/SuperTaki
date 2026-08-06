import type { Card } from '../engine/cards.ts';
import type { GameState, PlayerId } from '../engine/state.ts';
import { toPrivateHandView, toPublicGameState, type PublicGameState } from '../engine/views.ts';

/**
 * Everything a robot is allowed to know.
 *
 * This is the whole fairness argument, and it is structural rather than a
 * promise. A robot runs on the host, and the host holds every hand in memory —
 * so a policy that read {@link GameState} would be reading its opponents' cards.
 * It is handed the same projections a remote client is sent instead: the public
 * table, its own hand, and which seats are answering for themselves. Nothing else
 * exists as far as it is concerned, which is why "a robot cannot see your hand" is
 * a test rather than a claim.
 *
 * This is the *only* function in the package that is allowed to see a
 * {@link GameState}; a test asserts that no other file in `bot/` imports one.
 *
 * The list of who holds a +3 Breaker stays on the host. What a robot is given is one
 * bit of it, about itself — see {@link BotView.canAnswerPlusThree} — because
 * inferring that from its own hand is wrong in exactly the state it matters, and a
 * fact about your own seat is not information about anybody else's.
 */
export interface BotSeatView {
  readonly id: PlayerId;
  /**
   * Whether this seat can answer for itself.
   *
   * Presence is public — every client is told each seat's health in the lobby
   * snapshot — and it is needed for one decision only: somebody who is not there
   * cannot shout, so they cannot be called out for silence. A seat a robot is
   * playing counts as present, because the robot can shout for it.
   */
  readonly present: boolean;
}

export interface BotView {
  readonly playerId: PlayerId;
  /** The table as every client sees it. */
  readonly table: PublicGameState;
  /** This robot's own cards, and no others. */
  readonly hand: readonly Card[];
  readonly seats: readonly BotSeatView[];
  /**
   * Whether an open +3 is waiting on *this* seat.
   *
   * A fact about itself, not about anybody else: the list of who else holds a
   * breaker stays on the host. It is here because holding a breaker and being
   * waited for can come apart — a seat caught on its last card draws four cards
   * mid-window, and a breaker among them is not one the engine is waiting for.
   * Inferring it from the hand meant offering a move the table refuses, on the one
   * path that unfreezes everybody.
   */
  readonly canAnswerPlusThree: boolean;
}

export function botViewFor(
  state: GameState,
  playerId: PlayerId,
  isPresent: (playerId: PlayerId) => boolean,
): BotView {
  return {
    playerId,
    table: toPublicGameState(state),
    hand: toPrivateHandView(state, playerId).cards,
    seats: state.players.map((player) => ({ id: player.id, present: isPresent(player.id) })),
    canAnswerPlusThree: state.plusThree?.awaiting.includes(playerId) === true,
  };
}
