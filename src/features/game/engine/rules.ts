import { cardColor, cardSymbol, isWildCard, type Card, type CardColor, type CardId } from './cards.ts';
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
 * colourless cards are never allowed. That includes Taki cards: a sequence is
 * defined by its colour, and nothing inside it may repaint the table. A Taki of
 * any colour on a Taki is an ordinary symbol match — legal on your turn when no
 * sequence is open, and it opens a sequence of your own.
 *
 * Two situations override all of that: a pending +2 run can only be met with
 * another +2 or with a King, and the free play a King grants accepts anything.
 * See `docs/rules.md`.
 */
export function isCardPlayable(card: Card, context: PlayContext): boolean {
  if (context.openTakiColor !== null) {
    return cardColor(card) === context.openTakiColor;
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
