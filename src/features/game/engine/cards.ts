/**
 * Card model for Super Taki.
 *
 * The deck follows the Super Taki edition: numbers plus the five coloured
 * action cards, and the five colourless cards (Change Colour, Super Taki,
 * King, +3 and +3 Breaker). Cards are plain serialisable objects so they can
 * travel over the network unchanged. See `docs/rules.md`.
 */

export const CARD_COLORS = ['red', 'blue', 'green', 'yellow'] as const;
export type CardColor = (typeof CARD_COLORS)[number];

/**
 * The numbers printed on the deck.
 *
 * There is no plain 2: in Taki the only card carrying a 2 is the +2, which is
 * printed as a snapped "2" with a plus beside it. A separate number 2 would be a
 * card the physical deck does not contain, and it read as a +2 that had lost its
 * plus.
 */
export const NUMBER_VALUES = [1, 3, 4, 5, 6, 7, 8, 9] as const;
export type NumberValue = (typeof NUMBER_VALUES)[number];

/** Action cards that carry a colour. */
export const COLORED_ACTIONS = ['stop', 'plus', 'plusTwo', 'direction', 'taki'] as const;
export type ColoredActionKind = (typeof COLORED_ACTIONS)[number];

/**
 * Cards without a colour of their own. Only Change Colour lets the player pick
 * the next colour; the rest keep whatever colour is already leading.
 */
export const WILD_KINDS = ['colorChange', 'superTaki', 'king', 'plusThree', 'breakPlusThree'] as const;
export type WildKind = (typeof WILD_KINDS)[number];

export type CardKind = 'number' | ColoredActionKind | WildKind;

export type CardId = string;

export interface NumberCard {
  readonly id: CardId;
  readonly kind: 'number';
  readonly color: CardColor;
  readonly value: NumberValue;
}

export interface ColoredActionCard {
  readonly id: CardId;
  readonly kind: ColoredActionKind;
  readonly color: CardColor;
}

export interface WildCard {
  readonly id: CardId;
  readonly kind: WildKind;
}

export type Card = NumberCard | ColoredActionCard | WildCard;

/** Number of copies of every card, per colour where applicable. */
export const DECK_COMPOSITION = {
  /** Each number 1-9 exists twice per colour. */
  numberCopiesPerColor: 2,
  /** Each coloured action card exists twice per colour. */
  actionCopiesPerColor: 2,
  /** Colour-change cards in the whole deck. */
  colorChangeCount: 4,
  /** Super Taki cards in the whole deck. */
  superTakiCount: 2,
  /** King cards in the whole deck. */
  kingCount: 2,
  /** +3 cards in the whole deck. */
  plusThreeCount: 2,
  /** +3 Breaker cards in the whole deck. */
  breakPlusThreeCount: 2,
} as const;

export const CARDS_DEALT_PER_PLAYER = 8;

/** How many cards a +2 adds to the running penalty. */
export const PLUS_TWO_PENALTY = 2;

/** How many cards a +3 (or a broken +3) makes its victims draw. */
export const PLUS_THREE_PENALTY = 3;

/**
 * How many cards a player draws when another player catches them holding a
 * single undeclared card. See `docs/rules.md`.
 */
export const LAST_CARD_PENALTY = 4;

export function isWildCard(card: Card): card is WildCard {
  return (WILD_KINDS as readonly string[]).includes(card.kind);
}

export function isColoredCard(card: Card): card is NumberCard | ColoredActionCard {
  return !isWildCard(card);
}

export function isNumberCard(card: Card): card is NumberCard {
  return card.kind === 'number';
}

/**
 * Whether playing this card asks its owner to name the next colour.
 *
 * Only Change Colour does. Since the King joined the deck, the other
 * colourless cards — Super Taki, King, +3 and +3 Breaker — keep the colour
 * that is already leading.
 */
export function requiresColorChoice(card: Card): boolean {
  return card.kind === 'colorChange';
}

/** Colour of a card, or `null` for colourless cards. */
export function cardColor(card: Card): CardColor | null {
  return isWildCard(card) ? null : card.color;
}

/**
 * Stable identifier used for "same symbol" matching. Two cards match by symbol
 * when this value is equal (e.g. any `stop` matches any other `stop`).
 *
 * A Super Taki answers to `taki`, because that is what is printed on it: it is a
 * Taki that carries no colour of its own, and once played it *is* the leading
 * colour's Taki. Keeping it a symbol of its own made a coloured Taki illegal on
 * top of one — the table showed TAKI, the hand held TAKI, and the move was
 * refused — which is the one reading nobody at a table would arrive at.
 */
export function cardSymbol(card: Card): string {
  if (isNumberCard(card)) {
    return `number:${card.value}`;
  }
  return card.kind === 'superTaki' ? 'taki' : card.kind;
}

export function isCardColor(value: unknown): value is CardColor {
  return typeof value === 'string' && (CARD_COLORS as readonly string[]).includes(value);
}

/**
 * Builds the full ordered deck. The order is deterministic; shuffling is a
 * separate, seeded step so games can be replayed exactly.
 */
export function buildDeck(): Card[] {
  const cards: Card[] = [];
  const push = (card: Card): void => {
    cards.push(card);
  };

  for (const color of CARD_COLORS) {
    for (const value of NUMBER_VALUES) {
      for (let copy = 0; copy < DECK_COMPOSITION.numberCopiesPerColor; copy += 1) {
        push({ id: `n-${color}-${value}-${copy}`, kind: 'number', color, value });
      }
    }
    for (const kind of COLORED_ACTIONS) {
      for (let copy = 0; copy < DECK_COMPOSITION.actionCopiesPerColor; copy += 1) {
        push({ id: `a-${kind}-${color}-${copy}`, kind, color });
      }
    }
  }

  const wildCounts: Readonly<Record<WildKind, number>> = {
    colorChange: DECK_COMPOSITION.colorChangeCount,
    superTaki: DECK_COMPOSITION.superTakiCount,
    king: DECK_COMPOSITION.kingCount,
    plusThree: DECK_COMPOSITION.plusThreeCount,
    breakPlusThree: DECK_COMPOSITION.breakPlusThreeCount,
  };
  for (const kind of WILD_KINDS) {
    for (let copy = 0; copy < wildCounts[kind]; copy += 1) {
      push({ id: `w-${kind}-${copy}`, kind });
    }
  }

  return cards;
}

/** Total number of cards produced by {@link buildDeck}. */
export const DECK_SIZE =
  CARD_COLORS.length * NUMBER_VALUES.length * DECK_COMPOSITION.numberCopiesPerColor +
  CARD_COLORS.length * COLORED_ACTIONS.length * DECK_COMPOSITION.actionCopiesPerColor +
  DECK_COMPOSITION.colorChangeCount +
  DECK_COMPOSITION.superTakiCount +
  DECK_COMPOSITION.kingCount +
  DECK_COMPOSITION.plusThreeCount +
  DECK_COMPOSITION.breakPlusThreeCount;
