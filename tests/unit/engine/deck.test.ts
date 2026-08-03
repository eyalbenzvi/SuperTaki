import { describe, expect, it } from 'vitest';
import {
  CARD_COLORS,
  DECK_SIZE,
  buildDeck,
  cardColor,
  cardSymbol,
  isCardColor,
  isColoredCard,
  isNumberCard,
  isWildCard,
} from '../../../src/features/game/engine/cards.ts';

describe('deck composition', () => {
  const deck = buildDeck();

  it('contains the documented number of cards', () => {
    expect(deck).toHaveLength(110);
    expect(DECK_SIZE).toBe(110);
  });

  it('uses unique card ids', () => {
    const ids = new Set(deck.map((card) => card.id));
    expect(ids.size).toBe(deck.length);
  });

  it('has 72 number cards, two of each value per colour', () => {
    const numbers = deck.filter(isNumberCard);
    expect(numbers).toHaveLength(72);
    for (const color of CARD_COLORS) {
      for (let value = 1; value <= 9; value += 1) {
        const matches = numbers.filter((card) => card.color === color && card.value === value);
        expect(matches).toHaveLength(2);
      }
    }
  });

  it('has two of every coloured action card per colour', () => {
    for (const color of CARD_COLORS) {
      for (const kind of ['stop', 'plus', 'direction', 'taki'] as const) {
        const matches = deck.filter((card) => card.kind === kind && cardColor(card) === color);
        expect(matches).toHaveLength(2);
      }
    }
  });

  it('has four colour-change and two super taki wild cards', () => {
    expect(deck.filter((card) => card.kind === 'colorChange')).toHaveLength(4);
    expect(deck.filter((card) => card.kind === 'superTaki')).toHaveLength(2);
    expect(deck.filter(isWildCard)).toHaveLength(6);
    expect(deck.filter(isColoredCard)).toHaveLength(104);
  });

  it('reports colour as null for wild cards only', () => {
    for (const card of deck) {
      expect(cardColor(card)).toBe(isWildCard(card) ? null : (card as { color: string }).color);
    }
  });

  it('derives comparable symbols', () => {
    expect(cardSymbol({ id: 'x', kind: 'number', color: 'red', value: 7 })).toBe('number:7');
    expect(cardSymbol({ id: 'y', kind: 'stop', color: 'blue' })).toBe('stop');
    expect(cardSymbol({ id: 'z', kind: 'superTaki' })).toBe('superTaki');
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
