import { describe, expect, it } from 'vitest';
import { AnchorRegistry, centreOn, isUsable, toLocal } from '../../../src/features/game/ui/anchors.ts';

const rect = (left: number, top: number, width = 60, height = 90): DOMRectReadOnly =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRectReadOnly;

describe('converting to the overlay', () => {
  it('subtracts the overlay itself, not its parent', () => {
    /*
     * `inset: 0` resolves against the padding box and the element the overlay sits
     * inside has padding, so measuring against the parent would offset every
     * flight in the game by it.
     */
    const overlay = rect(12, 100, 366, 500);
    expect(toLocal(rect(40, 160), overlay)).toEqual({ left: 28, top: 60, width: 60, height: 90 });
  });

  it('describes a flight identically whichever way the page reads', () => {
    /*
     * The reason right-to-left costs nothing here: a viewport rectangle is
     * physical pixels from the physical left edge, so the same two anchors produce
     * the same numbers in Hebrew and in English and nothing needs mirroring.
     */
    const overlay = rect(0, 0, 400, 600);
    expect(toLocal(rect(300, 20), overlay).left).toBe(300);
  });
});

describe('centring a clone on an anchor', () => {
  it('puts the card in the middle of what it is flying to', () => {
    const target = { left: 100, top: 200, width: 100, height: 150 };
    expect(centreOn(target, { width: 60, height: 90 })).toEqual({
      left: 120,
      top: 230,
      width: 60,
      height: 90,
    });
  });

  it('leaves a same-sized clone where it is', () => {
    const target = { left: 10, top: 20, width: 60, height: 90 };
    expect(centreOn(target, { width: 60, height: 90 })).toEqual(target);
  });
});

describe('whether an anchor is worth flying between', () => {
  const overlay = rect(0, 0, 390, 600);

  it('accepts something on screen', () => {
    expect(isUsable({ left: 40, top: 300, width: 60, height: 90 }, overlay)).toBe(true);
  });

  it('rejects something with no size', () => {
    expect(isUsable({ left: 40, top: 300, width: 0, height: 90 }, overlay)).toBe(false);
  });

  it('rejects a slot scrolled out of the hand, or a seat out of the row', () => {
    // The hand scrolls vertically and the seat row horizontally, so this is a
    // real state rather than a defensive check — and a card flying in from
    // nowhere is worse than no card flying at all.
    expect(isUsable({ left: -200, top: 300, width: 60, height: 90 }, overlay)).toBe(false);
    expect(isUsable({ left: 500, top: 300, width: 60, height: 90 }, overlay)).toBe(false);
    expect(isUsable({ left: 40, top: -200, width: 60, height: 90 }, overlay)).toBe(false);
    expect(isUsable({ left: 40, top: 900, width: 60, height: 90 }, overlay)).toBe(false);
  });

  it('accepts something only partly on screen', () => {
    expect(isUsable({ left: -20, top: 300, width: 60, height: 90 }, overlay)).toBe(true);
  });
});

describe('the registry', () => {
  it('forgets an anchor that has unmounted', () => {
    const registry = new AnchorRegistry();
    const element = document.createElement('div');
    registry.set('pile:draw', element);
    expect(registry.elementOf('pile:draw')).toBe(element);
    registry.set('pile:draw', null);
    expect(registry.elementOf('pile:draw')).toBeNull();
  });

  it('reports nothing for an anchor that never existed', () => {
    /*
     * The normal case, not an error: a player's own seat is never in the seat
     * list, because the list holds opponents.
     */
    const registry = new AnchorRegistry();
    expect(registry.rectOf('seat:pl_me')).toBeNull();
    expect(registry.elementOf('seat:pl_me')).toBeNull();
  });

  it('reports nothing for an element with no box', () => {
    // Which is every element in jsdom, and a display:none element in a browser.
    const registry = new AnchorRegistry();
    registry.set('hand', document.createElement('div'));
    expect(registry.rectOf('hand')).toBeNull();
  });
});
