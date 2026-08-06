import { describe, expect, it } from 'vitest';
import {
  CARD_COLORS,
  DECK_SIZE,
  NUMBER_VALUES,
  buildDeck,
  cardColor,
  cardSymbol,
  isCardColor,
  isColoredCard,
  isNumberCard,
  isWildCard,
  requiresColorChoice,
} from '../../../src/features/game/engine/cards.ts';

describe('deck composition', () => {
  const deck = buildDeck();

  it('contains the documented number of cards', () => {
    expect(deck).toHaveLength(116);
    expect(DECK_SIZE).toBe(116);
  });

  it('uses unique card ids', () => {
    const ids = new Set(deck.map((card) => card.id));
    expect(ids.size).toBe(deck.length);
  });

  it('has 64 number cards, two of each value per colour, and no plain 2', () => {
    const numbers = deck.filter(isNumberCard);
    expect(numbers).toHaveLength(64);
    expect(NUMBER_VALUES).not.toContain(2);
    for (const color of CARD_COLORS) {
      for (const value of NUMBER_VALUES) {
        const matches = numbers.filter((card) => card.color === color && card.value === value);
        expect(matches).toHaveLength(2);
      }
    }
    // The only 2 in the deck is the +2, which is a coloured action card.
    expect(numbers.filter((card) => (card.value as number) === 2)).toHaveLength(0);
    expect(deck.filter((card) => card.kind === 'plusTwo')).toHaveLength(8);
  });

  it('has two of every coloured action card per colour', () => {
    for (const color of CARD_COLORS) {
      for (const kind of ['stop', 'plus', 'plusTwo', 'direction', 'taki'] as const) {
        const matches = deck.filter((card) => card.kind === kind && cardColor(card) === color);
        expect(matches).toHaveLength(2);
      }
    }
  });

  it('has the documented colourless cards', () => {
    expect(deck.filter((card) => card.kind === 'colorChange')).toHaveLength(4);
    expect(deck.filter((card) => card.kind === 'superTaki')).toHaveLength(2);
    expect(deck.filter((card) => card.kind === 'king')).toHaveLength(2);
    expect(deck.filter((card) => card.kind === 'plusThree')).toHaveLength(2);
    expect(deck.filter((card) => card.kind === 'breakPlusThree')).toHaveLength(2);
    expect(deck.filter(isWildCard)).toHaveLength(12);
    expect(deck.filter(isColoredCard)).toHaveLength(104);
  });

  it('asks for a colour only on colour change', () => {
    for (const card of deck) {
      expect(requiresColorChoice(card)).toBe(card.kind === 'colorChange');
    }
  });

  it('reports colour as null for wild cards only', () => {
    for (const card of deck) {
      expect(cardColor(card)).toBe(isWildCard(card) ? null : (card as { color: string }).color);
    }
  });

  it('derives comparable symbols', () => {
    expect(cardSymbol({ id: 'x', kind: 'number', color: 'red', value: 7 })).toBe('number:7');
    expect(cardSymbol({ id: 'y', kind: 'stop', color: 'blue' })).toBe('stop');
    // A Super Taki prints TAKI, so it compares as one. That is what makes a coloured
    // Taki legal on top of it.
    expect(cardSymbol({ id: 'z', kind: 'superTaki' })).toBe('taki');
    expect(cardSymbol({ id: 'w', kind: 'taki', color: 'yellow' })).toBe('taki');
    // Every other colourless card stays a symbol of its own.
    expect(cardSymbol({ id: 'v', kind: 'king' })).toBe('king');
    expect(cardSymbol({ id: 'u', kind: 'colorChange' })).toBe('colorChange');
  });

  it('validates colour strings', () => {
    expect(isCardColor('red')).toBe(true);
    expect(isCardColor('purple')).toBe(false);
    expect(isCardColor(7)).toBe(false);
  });

  it('is built in a stable order', () => {
    expect(buildDeck().map((card) => card.id)).toEqual(deck.map((card) => card.id));
  });
});
