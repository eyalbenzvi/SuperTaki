/**
 * Card model for Color Rush.
 *
 * The deck is an original definition documented in `docs/rules.md`. Cards are
 * plain serialisable objects so they can travel over the network unchanged.
 */

export const CARD_COLORS = ['red', 'blue', 'green', 'yellow'] as const;
export type CardColor = (typeof CARD_COLORS)[number];

export const NUMBER_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type NumberValue = (typeof NUMBER_VALUES)[number];

/** Action cards that carry a colour. */
export const COLORED_ACTIONS = ['stop', 'plus', 'direction', 'taki'] as const;
export type ColoredActionKind = (typeof COLORED_ACTIONS)[number];

/** Cards without a colour of their own; the player picks the active colour. */
export const WILD_KINDS = ['colorChange', 'superTaki'] as const;
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
  /** Colour-change wild cards in the whole deck. */
  colorChangeCount: 4,
  /** Super Taki wild cards in the whole deck. */
  superTakiCount: 2,
} as const;

export const CARDS_DEALT_PER_PLAYER = 8;

export function isWildCard(card: Card): card is WildCard {
  return card.kind === 'colorChange' || card.kind === 'superTaki';
}

export function isColoredCard(card: Card): card is NumberCard | ColoredActionCard {
  return !isWildCard(card);
}

export function isNumberCard(card: Card): card is NumberCard {
  return card.kind === 'number';
}

/** Colour of a card, or `null` for wild cards. */
export function cardColor(card: Card): CardColor | null {
  return isWildCard(card) ? null : card.color;
}

/**
 * Stable identifier used for "same symbol" matching. Two cards match by symbol
 * when this value is equal (e.g. any `stop` matches any other `stop`).
 */
export function cardSymbol(card: Card): string {
  return isNumberCard(card) ? `number:${card.value}` : card.kind;
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

  for (let copy = 0; copy < DECK_COMPOSITION.colorChangeCount; copy += 1) {
    push({ id: `w-colorChange-${copy}`, kind: 'colorChange' });
  }
  for (let copy = 0; copy < DECK_COMPOSITION.superTakiCount; copy += 1) {
    push({ id: `w-superTaki-${copy}`, kind: 'superTaki' });
  }

  return cards;
}

/** Total number of cards produced by {@link buildDeck}. */
export const DECK_SIZE =
  CARD_COLORS.length * NUMBER_VALUES.length * DECK_COMPOSITION.numberCopiesPerColor +
  CARD_COLORS.length * COLORED_ACTIONS.length * DECK_COMPOSITION.actionCopiesPerColor +
  DECK_COMPOSITION.colorChangeCount +
  DECK_COMPOSITION.superTakiCount;
