import {
  cardColor,
  cardSymbol,
  isTakiCard,
  isWildCard,
  type Card,
  type CardColor,
  type CardId,
} from './cards.ts';
import type { TurnDirection } from './state.ts';

/**
 * Minimal information needed to decide whether a card may be played.
 *
 * Deliberately smaller than {@link import('./state.ts').GameState} so that
 * non-host clients — which only ever hold public state plus their own hand —
 * can run exactly the same rule checks as the host.
 */
export interface PlayContext {
  readonly activeColor: CardColor;
  /** Visible top card of the discard pile, or `null` before the first play. */
  readonly topCard: Card | null;
  /** Colour an open Taki sequence is locked to, or `null` when none is open. */
  readonly openTakiColor: CardColor | null;
  /**
   * Whether another Taki may still be laid straight onto the run.
   *
   * True while the run is nothing but Taki cards. Meaningless when
   * `openTakiColor` is `null`.
   */
  readonly takiSwitchOpen: boolean;
  /**
   * Cards the player to move owes from a run of +2 cards; `0` when none. While
   * this is above zero the only legal cards are another +2 and a King.
   */
  readonly pendingDraw: number;
  /** Set after a King: anything in hand is legal. */
  readonly freePlay: boolean;
}

/**
 * Core matching rule.
 *
 * Outside a Taki sequence a card is playable when it is colourless, matches the
 * active colour, or matches the top card's symbol (number value or action kind).
 * Inside a Taki sequence only cards of the sequence colour are playable, and
 * colourless cards are never allowed.
 *
 * The one exception is a Taki laid straight onto another Taki: while the run is
 * still nothing but Taki cards, any Taki may be played — a coloured one carries
 * the sequence into its own colour, a Super Taki has none of its own and leaves
 * the run in the colour it is already in. As soon as an ordinary card joins the
 * run the colour is settled, and a Taki of a different colour is refused however
 * many same-colour Takis follow it.
 *
 * Two situations override all of that: a pending +2 run can only be met with
 * another +2 or with a King, and the free play a King grants accepts anything.
 * See `docs/rules.md`.
 */
export function isCardPlayable(card: Card, context: PlayContext): boolean {
  if (context.openTakiColor !== null) {
    if (cardColor(card) === context.openTakiColor) {
      return true;
    }
    /*
     * A Super Taki counts here exactly as a coloured one does. A coloured Taki is
     * legal on top of a Super Taki — the symbols match — so a Super Taki has to be
     * legal on top of a Taki too, or the rule would read in one direction only. It
     * simply has no colour to carry the run into, so the run stays where it is.
     */
    return context.takiSwitchOpen && isTakiCard(card);
  }
  if (context.pendingDraw > 0) {
    // Two cards meet a run, and they meet it differently: a +2 raises it and
    // passes it on, a King wipes it. Everything else draws the run.
    return card.kind === 'plusTwo' || card.kind === 'king';
  }
  if (context.freePlay || isWildCard(card)) {
    return true;
  }
  if (cardColor(card) === context.activeColor) {
    return true;
  }
  return context.topCard !== null && cardSymbol(card) === cardSymbol(context.topCard);
}

export function getPlayableCardIds(hand: readonly Card[], context: PlayContext): CardId[] {
  return hand.filter((card) => isCardPlayable(card, context)).map((card) => card.id);
}

export function hasPlayableCard(hand: readonly Card[], context: PlayContext): boolean {
  return hand.some((card) => isCardPlayable(card, context));
}

/** Seat index that follows `index` in the given direction, wrapping around. */
export function stepIndex(index: number, direction: TurnDirection, playerCount: number): number {
  if (playerCount <= 0) {
    throw new RangeError('playerCount must be greater than 0');
  }
  return (((index + direction) % playerCount) + playerCount) % playerCount;
}
