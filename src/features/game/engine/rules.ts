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
}

/**
 * Core matching rule.
 *
 * Outside a Taki sequence a card is playable when it is wild, matches the
 * active colour, or matches the top card's symbol (number value or action kind).
 * Inside a Taki sequence only cards of the sequence colour are playable, and
 * wild cards are never allowed. See `docs/rules.md`.
 */
export function isCardPlayable(card: Card, context: PlayContext): boolean {
  if (context.openTakiColor !== null) {
    return cardColor(card) === context.openTakiColor;
  }
  if (isWildCard(card)) {
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
