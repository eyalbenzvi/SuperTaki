import { describe, expect, it } from 'vitest';
import {
  MIN_STRIP_RATIO,
  UNMEASURED,
  rowCount,
  solveHandLayout,
} from '../../../src/features/game/ui/handLayout.ts';

/** A phone's hand area, and the card size the stylesheet gives it there. */
const PHONE = 374;
const CARD = 68;

describe('arranging a hand', () => {
  it('spreads a small hand out, with a real gap between the cards', () => {
    const layout = solveHandLayout(PHONE, CARD, 3);
    expect(layout.perRow).toBe(3);
    expect(rowCount(layout, 3)).toBe(1);
    // Room to spare, so the cards do not touch.
    expect(layout.strip).toBeGreaterThan(CARD);
  });

  it('closes the hand up before it ever needs a second row', () => {
    const layout = solveHandLayout(PHONE, CARD, 6);
    expect(rowCount(layout, 6)).toBe(1);
    expect(layout.strip).toBeLessThan(CARD);
    // Every card keeps at least its own half.
    expect(layout.strip).toBeGreaterThanOrEqual(CARD * MIN_STRIP_RATIO);
  });

  it('never overlaps a card by more than half of it', () => {
    for (let count = 1; count <= 20; count += 1) {
      const layout = solveHandLayout(PHONE, CARD, count);
      expect(layout.strip).toBeGreaterThanOrEqual(CARD * MIN_STRIP_RATIO);
    }
  });

  it('keeps every card of a big hand on screen, on as many rows as that takes', () => {
    for (const count of [9, 10, 12, 14, 18, 24]) {
      const layout = solveHandLayout(PHONE, CARD, count);
      const rows = rowCount(layout, count);
      // The widest row must fit: the first card whole, then one strip each.
      const widest = CARD + (layout.perRow - 1) * layout.strip;
      expect(widest).toBeLessThanOrEqual(PHONE + 0.001);
      expect(rows * layout.perRow).toBeGreaterThanOrEqual(count);
    }
  });

  it('balances the rows rather than stranding two cards on the second', () => {
    // 11 cards at a capacity of 9 is 6 + 5, not 9 + 2.
    const layout = solveHandLayout(PHONE, CARD, 11);
    expect(rowCount(layout, 11)).toBe(2);
    expect(layout.perRow).toBe(6);
  });

  it('uses the width it is given: landscape keeps a big hand on one row', () => {
    const landscape = solveHandLayout(760, 52, 14);
    expect(rowCount(landscape, 14)).toBe(1);
    expect(landscape.perRow).toBe(14);
  });

  it('gives up rather than guess when nothing has been measured', () => {
    expect(solveHandLayout(0, CARD, 5)).toEqual(UNMEASURED);
    expect(solveHandLayout(PHONE, 0, 5)).toEqual(UNMEASURED);
    expect(solveHandLayout(PHONE, CARD, 0)).toEqual(UNMEASURED);
    expect(rowCount(UNMEASURED, 5)).toBe(1);
  });

  it('shows a single card whole even on a screen narrower than a card', () => {
    const layout = solveHandLayout(40, CARD, 4);
    expect(layout.perRow).toBe(1);
    expect(layout.strip).toBe(CARD);
    expect(rowCount(layout, 4)).toBe(4);
  });
});
