import { describe, expect, it } from 'vitest';
import {
  handDeltas,
  isSettled,
  sameCards,
  type SlotGeometry,
  type SlotMap,
} from '../../../src/features/game/ui/handFlip.ts';

/**
 * The only part of the hand's motion that can be proven.
 *
 * jsdom has no `ResizeObserver`, so the layout solver bails out and every rect is
 * zero — a component test can show the hand still renders without a platform
 * animation, which is worth having, but it cannot say a single true thing about
 * this arithmetic. So the arithmetic lives here, on its own, as data in and data
 * out.
 */

function slots(entries: Record<string, [number, number, number]>): SlotMap {
  const map = new Map<string, SlotGeometry>();
  for (const [cardId, [left, top, cardWidth]] of Object.entries(entries)) {
    map.set(cardId, { left, top, cardWidth });
  }
  return map;
}

describe('what moved', () => {
  it('reports the distance a card has to travel back', () => {
    const before = slots({ a: [100, 500, 68] });
    const after = slots({ a: [140, 500, 68] });
    const [delta] = handDeltas(before, after);
    // The card is drawn at its new position and animated *from* the old one, so
    // the delta points backwards.
    expect(delta).toMatchObject({ cardId: 'a', dx: -40, dy: 0, scale: 1 });
  });

  it('reports a move onto another row', () => {
    const before = slots({ a: [300, 500, 68] });
    const after = slots({ a: [20, 560, 68] });
    const [delta] = handDeltas(before, after);
    expect(delta?.dx).toBe(280);
    expect(delta?.dy).toBe(-60);
  });

  it('carries the resize, because the hand shrinks as it grows', () => {
    /*
     * The case a translate-only FLIP gets wrong: paying a four-card penalty can
     * cross a scale step, so every card moves *and* resizes in the same frame. A
     * translate alone animates the movement and lets the resize snap underneath.
     */
    const before = slots({ a: [100, 500, 68] });
    const after = slots({ a: [80, 500, 63.24] });
    const [delta] = handDeltas(before, after);
    expect(delta?.scale).toBeCloseTo(68 / 63.24, 5);
  });

  it('ignores a card that has only just arrived', () => {
    // It has no "before" to come from. The overlay flies it in, or it appears.
    const before = slots({ a: [100, 500, 68] });
    const after = slots({ a: [100, 500, 68], b: [160, 500, 68] });
    expect(handDeltas(before, after)).toHaveLength(0);
  });

  it('ignores a card that has gone', () => {
    const before = slots({ a: [100, 500, 68], b: [160, 500, 68] });
    const after = slots({ a: [100, 500, 68] });
    // Nothing to animate: the slot went with the card.
    expect(handDeltas(before, after)).toHaveLength(0);
  });

  it('does not promote a layer for movement nobody can see', () => {
    const before = slots({ a: [100, 500, 68], b: [200, 500, 68] });
    const after = slots({ a: [100.2, 500.1, 68], b: [200, 500, 68.001] });
    expect(handDeltas(before, after)).toHaveLength(0);
  });

  it('describes every card that genuinely moved, and only those', () => {
    const before = slots({ a: [100, 500, 68], b: [160, 500, 68], c: [220, 500, 68] });
    const after = slots({ a: [100, 500, 68], b: [200, 500, 68], c: [260, 500, 68] });
    const moved = handDeltas(before, after).map((delta) => delta.cardId);
    expect(moved).toEqual(['b', 'c']);
  });

  it('survives a zero-width card without dividing by it', () => {
    const before = slots({ a: [100, 500, 68] });
    const after = slots({ a: [120, 500, 0] });
    const [delta] = handDeltas(before, after);
    expect(delta?.scale).toBe(1);
    expect(Number.isFinite(delta?.dx ?? NaN)).toBe(true);
  });
});

describe('whether a measurement is worth using', () => {
  it('rejects an empty hand', () => {
    expect(isSettled(slots({}))).toBe(false);
  });

  it('rejects a hand whose cards have no width yet', () => {
    /*
     * The layout is solved across two commits: the scale is computed inline from
     * the card count and lands one render before the solver's track width does.
     * Measuring in between animates towards a position the browser is about to
     * replace, which reads as a double move.
     */
    expect(isSettled(slots({ a: [100, 500, 68], b: [160, 500, 0] }))).toBe(false);
  });

  it('accepts a hand that has real geometry', () => {
    expect(isSettled(slots({ a: [100, 500, 68], b: [160, 500, 68] }))).toBe(true);
  });
});

describe('whether the hand holds the same cards', () => {
  it('is true when only positions changed', () => {
    // The solver's own second commit: same cards, new tracks. Not a move.
    const before = slots({ a: [100, 500, 68], b: [160, 500, 68] });
    const after = slots({ a: [90, 500, 68], b: [150, 500, 68] });
    expect(sameCards(before, after)).toBe(true);
  });

  it('is false when a card arrives or leaves', () => {
    const two = slots({ a: [0, 0, 68], b: [0, 0, 68] });
    expect(sameCards(two, slots({ a: [0, 0, 68] }))).toBe(false);
    expect(sameCards(two, slots({ a: [0, 0, 68], b: [0, 0, 68], c: [0, 0, 68] }))).toBe(false);
  });

  it('is false when one card was swapped for another of the same count', () => {
    const before = slots({ a: [0, 0, 68], b: [0, 0, 68] });
    const after = slots({ a: [0, 0, 68], c: [0, 0, 68] });
    expect(sameCards(before, after)).toBe(false);
  });
});
