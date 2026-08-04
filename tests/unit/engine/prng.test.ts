import { describe, expect, it } from 'vitest';
import {
  createRng,
  nextFloat,
  nextInt,
  seedFromString,
  shuffle,
} from '../../../src/features/game/engine/prng.ts';
import { buildDeck } from '../../../src/features/game/engine/cards.ts';

describe('seeded prng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = [...Array(20).keys()].reduce<{ state: ReturnType<typeof createRng>; out: number[] }>(
      (acc) => {
        const next = nextFloat(acc.state);
        acc.out.push(next.value);
        return { state: next.state, out: acc.out };
      },
      { state: createRng(42), out: [] },
    ).out;

    const b = [...Array(20).keys()].reduce<{ state: ReturnType<typeof createRng>; out: number[] }>(
      (acc) => {
        const next = nextFloat(acc.state);
        acc.out.push(next.value);
        return { state: next.state, out: acc.out };
      },
      { state: createRng(42), out: [] },
    ).out;

    expect(a).toEqual(b);
  });

  it('produces different sequences for different seeds', () => {
    expect(nextFloat(createRng(1)).value).not.toBe(nextFloat(createRng(2)).value);
  });

  it('stays inside [0, 1)', () => {
    let state = createRng(7);
    for (let i = 0; i < 500; i += 1) {
      const next = nextFloat(state);
      expect(next.value).toBeGreaterThanOrEqual(0);
      expect(next.value).toBeLessThan(1);
      state = next.state;
    }
  });

  it('bounds integers', () => {
    let state = createRng(99);
    for (let i = 0; i < 200; i += 1) {
      const next = nextInt(state, 6);
      expect(next.value).toBeGreaterThanOrEqual(0);
      expect(next.value).toBeLessThan(6);
      state = next.state;
    }
    expect(() => nextInt(createRng(1), 0)).toThrow(RangeError);
  });

  it('derives stable seeds from strings', () => {
    expect(seedFromString('482913')).toBe(seedFromString('482913'));
    expect(seedFromString('a')).not.toBe(seedFromString('b'));
    expect(seedFromString('')).toBeGreaterThanOrEqual(0);
  });
});

describe('deterministic shuffle', () => {
  it('does not mutate the input', () => {
    const deck = buildDeck();
    const snapshot = deck.map((card) => card.id);
    shuffle(deck, createRng(5));
    expect(deck.map((card) => card.id)).toEqual(snapshot);
  });

  it('is a permutation', () => {
    const deck = buildDeck();
    const shuffled = shuffle(deck, createRng(5)).items;
    expect(shuffled).toHaveLength(deck.length);
    expect(new Set(shuffled.map((card) => card.id))).toEqual(new Set(deck.map((card) => card.id)));
  });

  it('is reproducible for a given seed and differs across seeds', () => {
    const first = shuffle(buildDeck(), createRng(5)).items.map((card) => card.id);
    const same = shuffle(buildDeck(), createRng(5)).items.map((card) => card.id);
    const other = shuffle(buildDeck(), createRng(6)).items.map((card) => card.id);
    expect(first).toEqual(same);
    expect(first).not.toEqual(other);
  });

  it('advances the rng state', () => {
    const start = createRng(5);
    expect(shuffle(buildDeck(), start).state.seed).not.toBe(start.seed);
  });

  it('handles empty and single-item inputs', () => {
    expect(shuffle([], createRng(1)).items).toEqual([]);
    expect(shuffle(['only'], createRng(1)).items).toEqual(['only']);
  });
});
