import { describe, expect, it } from 'vitest';
import {
  ASSIST_LEVELS,
  MAX_ASSIST_WEIGHT,
  anyAssisted,
  assignHands,
  assistFor,
  assistWeight,
  biasedStartIndex,
  chooseDrawIndex,
  drawWindow,
  frontLoadForDraw,
  handStrength,
  preferredOpeningColor,
} from '../../../src/features/game/engine/assist.ts';
import { DECK_SIZE, type Card } from '../../../src/features/game/engine/cards.ts';
import { applyCommand, createGame, playContextFromState } from '../../../src/features/game/engine/engine.ts';
import { isCardPlayable } from '../../../src/features/game/engine/rules.ts';
import type { GameState, PlayerId } from '../../../src/features/game/engine/state.ts';
import { cards, makeState, players } from '../helpers/engineFixtures.ts';

/**
 * The easements, tested against the three promises the module makes.
 *
 * The first two are properties and they are the ones that matter: cards are
 * conserved whatever the lean, and a table nobody is leaning towards produces
 * exactly the round it produced before any of this existed. The third — that the
 * lean actually leans — is what the examples are for.
 */

const TABLE = players('Ada', 'Ben', 'Cal');
const [ADA, BEN] = TABLE.map((player) => player.id) as [PlayerId, PlayerId];

/** Every card in a state, wherever it is. The count that must never move. */
function census(state: GameState): string[] {
  return [
    ...Object.values(state.hands).flatMap((hand) => hand.map((card) => card.id)),
    ...state.drawPile.map((card) => card.id),
    ...state.discardPile.map((card) => card.id),
  ].sort();
}

function dealt(seed: number, assist: Record<PlayerId, number> = {}, round = 0): GameState {
  const result = createGame(TABLE, seed, 1, round, 'classic', assist);
  if (!result.ok) {
    throw new Error(`the deal was refused: ${result.rejection.code}`);
  }
  return result.state;
}

describe('the dial', () => {
  it('reads nought for anything that is not a weight', () => {
    expect(assistFor({}, ADA)).toBe(0);
    expect(assistFor({ [ADA]: Number.NaN }, ADA)).toBe(0);
    expect(assistFor({ [ADA]: -4 }, ADA)).toBe(0);
    // Clamped rather than trusted: this record survives a round trip through storage.
    expect(assistFor({ [ADA]: 99 }, ADA)).toBe(MAX_ASSIST_WEIGHT);
  });

  it('turns every level into a weight, and only "off" into nought', () => {
    expect(ASSIST_LEVELS.map(assistWeight)).toEqual([0, 1, 2, 3]);
    expect(anyAssisted({})).toBe(false);
    expect(anyAssisted({ [ADA]: 0 })).toBe(false);
    expect(anyAssisted({ [ADA]: 1 })).toBe(true);
  });

  it('widens the draw window with the dial and never below the top card', () => {
    expect([0, 1, 2, 3].map(drawWindow)).toEqual([1, 2, 3, 5]);
  });
});

describe('the deal', () => {
  it('is a permutation: every card dealt is still dealt, to somebody', () => {
    const hands = [cards('red:1', 'red:3'), cards('king', 'superTaki'), cards('blue:4', 'green:5')];
    const before = hands
      .flat()
      .map((card) => card.id)
      .sort();
    const after = assignHands(hands, TABLE, { [BEN]: 2 })
      .flat()
      .map((card) => card.id)
      .sort();
    expect(after).toEqual(before);
  });

  it('gives the strongest hand to the seat the table leans towards', () => {
    const weak = cards('red:1', 'blue:3');
    const strong = cards('king', 'plusThree');
    const middling = cards('green:4', 'green:taki');
    const assigned = assignHands([weak, strong, middling], TABLE, { [BEN]: 1 });
    expect(handStrength(strong)).toBeGreaterThan(handStrength(middling));
    expect(assigned[1]).toBe(strong);
    // The seats that were not marked keep what is left, in the order it was dealt.
    expect(assigned[0]).toBe(weak);
    expect(assigned[2]).toBe(middling);
  });

  it('leaves the deal alone when every seat is marked', () => {
    const hands = [cards('red:1'), cards('king'), cards('blue:4')];
    const everybody = Object.fromEntries(TABLE.map((player) => [player.id, 3]));
    expect(assignHands(hands, TABLE, everybody)).toBe(hands);
  });

  it('conserves the deck for every level, at every seed', () => {
    const plain = dealt(11);
    for (const level of ASSIST_LEVELS) {
      const state = dealt(11, { [BEN]: assistWeight(level) });
      expect(census(state)).toEqual(census(plain));
      expect(census(state)).toHaveLength(DECK_SIZE);
    }
  });

  it('is identical to an untouched deal when nobody is marked', () => {
    /*
     * The promise the whole feature rests on: an ordinary table is not merely fair
     * but byte-for-byte the round it would have been. The weights themselves are the
     * one field allowed to differ, because a record of noughts and an empty record
     * say the same thing and the engine reads both as nothing.
     */
    for (const seed of [1, 2, 3, 99, 12345]) {
      expect({ ...dealt(seed, {}), assist: {} }).toEqual({
        ...dealt(seed, { [ADA]: 0, [BEN]: 0 }),
        assist: {},
      });
    }
  });

  it('hands a marked seat a hand at least as strong as the one it would have had', () => {
    let better = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      const plain = handStrength(dealt(seed).hands[BEN] ?? []);
      const leaned = handStrength(dealt(seed, { [BEN]: 3 }).hands[BEN] ?? []);
      expect(leaned).toBeGreaterThanOrEqual(plain);
      if (leaned > plain) {
        better += 1;
      }
    }
    /*
     * And usually strictly better. Not always, and the number says why: at a table
     * of three the seat's own hand was already the best of the three about a third
     * of the time, and on those deals there is nothing to improve.
     */
    expect(better).toBeGreaterThan(20);
  });
});

describe('the opening card', () => {
  it('prefers the colour the marked hand leans on', () => {
    const wanted = preferredOpeningColor({ [ADA]: cards('green:1', 'green:3', 'red:4'), [BEN]: [] }, TABLE, {
      [ADA]: 2,
    });
    expect(wanted).toBe('green');
  });

  it('asks for nothing when nobody is marked', () => {
    expect(preferredOpeningColor({ [ADA]: cards('green:1') }, TABLE, {})).toBeNull();
  });

  it('opens in the marked hand’s colour far more often than chance would', () => {
    let matched = 0;
    for (let seed = 0; seed < 60; seed += 1) {
      const state = dealt(seed, { [BEN]: 1 });
      const hand = state.hands[BEN] ?? [];
      const counts: Record<string, number> = {};
      for (const card of hand) {
        const color = 'color' in card ? card.color : null;
        if (color !== null) {
          counts[color] = (counts[color] ?? 0) + 1;
        }
      }
      const leading = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (state.activeColor === leading) {
        matched += 1;
      }
    }
    // A quarter would be chance. The budget on the scan is why it is not all of them.
    expect(matched).toBeGreaterThan(40);
  });
});

describe('the draw pile', () => {
  const pile = cards('red:1', 'king', 'blue:9');

  it('takes the top card for an unmarked seat, whatever is under it', () => {
    const context = {
      activeColor: 'red' as const,
      topCard: null,
      openTakiColor: null,
      takiSwitchOpen: false,
      pendingDraw: 0,
      freePlay: false,
    };
    expect(chooseDrawIndex(pile, 0, [], context)).toBe(0);
    // A King is worth more than a red 1 — but only a marked seat may reach for it.
    expect(chooseDrawIndex(pile, 2, [], context)).toBe(1);
  });

  it('judges playability as if nothing were owed', () => {
    /*
     * Mid-payment of a +2 run every card is illegal, so the literal question would
     * score them all alike and throw the window away on the turn it matters most.
     */
    const owing = {
      activeColor: 'blue' as const,
      topCard: null,
      openTakiColor: null,
      takiSwitchOpen: false,
      pendingDraw: 6,
      freePlay: false,
    };
    const choices = cards('red:1', 'blue:4');
    expect(chooseDrawIndex(choices, 2, [], owing)).toBe(1);
  });

  it('front-loads a recycle without gaining or losing a card', () => {
    const context = {
      activeColor: 'blue' as const,
      topCard: null,
      openTakiColor: null,
      takiSwitchOpen: false,
      pendingDraw: 0,
      freePlay: false,
    };
    const shuffled = cards('red:1', 'red:3', 'king', 'blue:5', 'green:7');
    const arranged = frontLoadForDraw(shuffled, 2, [], context);
    expect([...arranged].map((card) => card.id).sort()).toEqual(shuffled.map((card) => card.id).sort());
    expect(arranged[0]?.kind).toBe('king');
    // Untouched for a seat nobody is leaning towards — the same array, not a copy.
    expect(frontLoadForDraw(shuffled, 0, [], context)).toBe(shuffled);
  });

  it('keeps the deck whole across a whole round of biased draws', () => {
    let state = dealt(5, { [BEN]: 3 });
    const start = census(state);
    for (let turn = 0; turn < 60 && state.phase === 'playing'; turn += 1) {
      const player = state.players[state.currentPlayerIndex];
      if (!player) {
        break;
      }
      const result = applyCommand(state, { type: 'drawCard', playerId: player.id });
      if (!result.ok) {
        break;
      }
      state = result.state;
      expect(census(state)).toEqual(start);
    }
    expect(census(state)).toHaveLength(DECK_SIZE);
  });

  it('reaches past the top card for a marked seat, and not for anybody else', () => {
    // Red is leading, so the green 3 on top is dead and the King under it is not.
    const table = {
      players: TABLE,
      hands: {
        [ADA]: cards('blue:9'),
        [BEN]: cards('yellow:8'),
        [TABLE[2]?.id ?? '']: cards('green:9'),
      },
      drawPile: cards('green:3', 'red:5', 'king'),
      discardPile: cards('red:9'),
      currentPlayerIndex: 1,
    };
    const drawn = (assist: Record<PlayerId, number>): Card | undefined => {
      const result = applyCommand(makeState({ ...table, assist }), {
        type: 'drawCard',
        playerId: BEN,
      });
      if (!result.ok) {
        throw new Error(`the draw was refused: ${result.rejection.code}`);
      }
      const hand = result.state.hands[BEN] ?? [];
      return hand[hand.length - 1];
    };
    expect(drawn({})?.kind).toBe('number');
    expect(drawn({ [BEN]: 3 })?.kind).toBe('king');
  });

  it('leaves a marked seat holding more it can play, over a run of rounds', () => {
    const usable = (state: GameState): number => {
      const context = playContextFromState(state);
      return (state.hands[BEN] ?? []).filter((card) => isCardPlayable(card, context)).length;
    };
    let leaned = 0;
    let plain = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      // An odd round, so this seat is the one on turn in both games and may draw.
      const before = dealt(seed, {}, 1);
      const after = dealt(seed, { [BEN]: 3 }, 1);
      const step = (state: GameState): GameState => {
        const result = applyCommand(state, { type: 'drawCard', playerId: BEN });
        return result.ok ? result.state : state;
      };
      plain += usable(step(before));
      leaned += usable(step(after));
    }
    expect(leaned).toBeGreaterThan(plain);
  });
});

describe('who opens', () => {
  it('leaves even rounds to the ordinary rotation', () => {
    expect(biasedStartIndex(TABLE, { [BEN]: 3 }, 0, 0)).toBe(0);
    expect(biasedStartIndex(TABLE, { [BEN]: 3 }, 2, 2)).toBe(2);
  });

  it('hands odd rounds to a marked seat', () => {
    expect(biasedStartIndex(TABLE, { [BEN]: 1 }, 1, 1)).toBe(1);
    expect(biasedStartIndex(TABLE, { [BEN]: 1 }, 3, 0)).toBe(1);
  });

  it('rotates between marked seats rather than picking the same one for ever', () => {
    const two = { [ADA]: 1, [BEN]: 1 };
    expect(biasedStartIndex(TABLE, two, 1, 1)).toBe(0);
    expect(biasedStartIndex(TABLE, two, 3, 0)).toBe(1);
  });

  it('changes nothing when nobody is marked, or when everybody is', () => {
    expect(biasedStartIndex(TABLE, {}, 1, 1)).toBe(1);
    const everybody = Object.fromEntries(TABLE.map((player) => [player.id, 2]));
    expect(biasedStartIndex(TABLE, everybody, 1, 1)).toBe(1);
  });

  it('carries the lean through a real deal', () => {
    expect(dealt(4, { [BEN]: 2 }, 1).currentPlayerIndex).toBe(1);
    expect(dealt(4, {}, 1).currentPlayerIndex).toBe(1 % TABLE.length);
  });
});
