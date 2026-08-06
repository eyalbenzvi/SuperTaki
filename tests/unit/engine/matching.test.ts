import { describe, expect, it } from 'vitest';
import {
  getPlayableCardIds,
  hasPlayableCard,
  isCardPlayable,
  stepIndex,
  type PlayContext,
} from '../../../src/features/game/engine/rules.ts';
import { card, cards } from '../helpers/engineFixtures.ts';

function context(overrides: Partial<PlayContext> = {}): PlayContext {
  return {
    activeColor: 'red',
    topCard: card('red:5'),
    openTakiColor: null,
    takiSwitchOpen: false,
    pendingDraw: 0,
    freePlay: false,
    ...overrides,
  };
}

describe('card matching', () => {
  it('accepts a card of the active colour', () => {
    expect(isCardPlayable(card('red:3'), context())).toBe(true);
  });

  it('accepts a card with the same number value', () => {
    expect(isCardPlayable(card('blue:5'), context())).toBe(true);
  });

  it('rejects a mismatching colour and value', () => {
    expect(isCardPlayable(card('blue:3'), context())).toBe(false);
  });

  it('accepts any wild card', () => {
    expect(isCardPlayable(card('colorChange'), context())).toBe(true);
    expect(isCardPlayable(card('superTaki'), context())).toBe(true);
  });

  it('matches action cards by symbol across colours', () => {
    const ctx = context({ topCard: card('red:stop'), activeColor: 'red' });
    expect(isCardPlayable(card('green:stop'), ctx)).toBe(true);
    expect(isCardPlayable(card('green:plus'), ctx)).toBe(false);
    expect(isCardPlayable(card('red:plus'), ctx)).toBe(true);
  });

  it('matches taki cards by symbol across colours', () => {
    const ctx = context({ topCard: card('yellow:taki'), activeColor: 'yellow' });
    expect(isCardPlayable(card('blue:taki'), ctx)).toBe(true);
    expect(isCardPlayable(card('blue:4'), ctx)).toBe(false);
  });

  it('takes a Super Taki as a Taki, in both directions', () => {
    /*
     * The reported bug, exactly: a Super Taki closed on top, the colour it left
     * behind red, and a yellow Taki in hand that the table refused. The card says
     * TAKI on both sides of that comparison.
     */
    const onSuper = context({ topCard: card('superTaki'), activeColor: 'red' });
    expect(isCardPlayable(card('yellow:taki'), onSuper)).toBe(true);
    expect(isCardPlayable(card('red:taki'), onSuper)).toBe(true);
    // Nothing else about the Super Taki became a symbol match: it repaints nothing,
    // so a yellow anything-else is still refused on a red table.
    expect(isCardPlayable(card('yellow:stop'), onSuper)).toBe(false);
    expect(isCardPlayable(card('yellow:4'), onSuper)).toBe(false);

    // And the other way round, which held already because a Super Taki is wild.
    const onTaki = context({ topCard: card('yellow:taki'), activeColor: 'yellow' });
    expect(isCardPlayable(card('superTaki'), onTaki)).toBe(true);
  });

  it('uses the chosen colour after a wild card, with no symbol match available', () => {
    const ctx = context({ topCard: card('colorChange'), activeColor: 'green' });
    expect(isCardPlayable(card('green:1'), ctx)).toBe(true);
    expect(isCardPlayable(card('red:1'), ctx)).toBe(false);
    expect(isCardPlayable(card('colorChange'), ctx)).toBe(true);
  });

  it('falls back to colour matching when there is no top card', () => {
    const ctx = context({ topCard: null, activeColor: 'blue' });
    expect(isCardPlayable(card('blue:9'), ctx)).toBe(true);
    expect(isCardPlayable(card('red:9'), ctx)).toBe(false);
  });

  describe('inside an open taki sequence', () => {
    const ctx = context({ openTakiColor: 'green', activeColor: 'green' });

    it('allows any card of the sequence colour', () => {
      expect(isCardPlayable(card('green:1'), ctx)).toBe(true);
      expect(isCardPlayable(card('green:stop'), ctx)).toBe(true);
      expect(isCardPlayable(card('green:plus'), ctx)).toBe(true);
      expect(isCardPlayable(card('green:direction'), ctx)).toBe(true);
      expect(isCardPlayable(card('green:taki'), ctx)).toBe(true);
    });

    it('rejects other colours even when the symbol matches', () => {
      expect(isCardPlayable(card('red:1'), { ...ctx, topCard: card('green:1') })).toBe(false);
    });

    it('rejects wild cards', () => {
      expect(isCardPlayable(card('colorChange'), ctx)).toBe(false);
      expect(isCardPlayable(card('superTaki'), ctx)).toBe(false);
    });
  });

  it('lists and detects playable cards in a hand', () => {
    const hand = cards('red:1', 'blue:3', 'colorChange');
    const ids = getPlayableCardIds(hand, context());
    expect(ids).toHaveLength(2);
    expect(hasPlayableCard(hand, context())).toBe(true);
    expect(hasPlayableCard(cards('blue:3'), context())).toBe(false);
    expect(hasPlayableCard([], context())).toBe(false);
  });
});

describe('stepIndex', () => {
  it('moves forwards and wraps', () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0);
  });

  it('moves backwards and wraps', () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, -1, 3)).toBe(1);
  });

  it('alternates between two seats in both directions', () => {
    expect(stepIndex(0, 1, 2)).toBe(1);
    expect(stepIndex(0, -1, 2)).toBe(1);
    expect(stepIndex(1, -1, 2)).toBe(0);
  });

  it('rejects an empty table', () => {
    expect(() => stepIndex(0, 1, 0)).toThrow(RangeError);
  });
});
