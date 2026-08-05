import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import type { Card } from '../../src/features/game/engine/cards.ts';
import { GUEST_ID, enterGame, renderApp, resetStore, setState } from './helpers.tsx';

/**
 * The flight layer, with a platform that can animate.
 *
 * Sequence numbers here are deliberately small. The planner drops everything but
 * the essential landing when the view has fallen more than two beats behind, so a
 * beat numbered 25 arriving at a freshly mounted layer exercises the catch-up rule
 * rather than the normal path — which is correct behaviour and the wrong thing to
 * be testing here.
 *
 * jsdom implements no Web Animations API, so `animate()` returns `null` and the
 * whole clone path is skipped — which is correct behaviour and proves the
 * degradation, but leaves the code that actually does the work unexecuted. A
 * minimal stub is installed here so the interesting half runs: clones get created,
 * positioned, neutralised and cleaned up, and the cleanup can be driven by hand.
 *
 * The stub is honest about what it is. It does not interpolate anything, so nothing
 * here asserts how a flight *looks*; the browser suite does that. What it asserts is
 * the bookkeeping: one clone per motion, nothing focusable, nothing left behind.
 */

interface FakeAnimation {
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
  cancel: () => void;
  finish: () => void;
}

let animations: FakeAnimation[] = [];

beforeEach(() => {
  resetStore();
  animations = [];
  (Element.prototype as { animate?: unknown }).animate = function (): FakeAnimation {
    const animation: FakeAnimation = {
      onfinish: null,
      oncancel: null,
      cancel() {
        this.oncancel?.();
      },
      finish() {
        this.onfinish?.();
      },
    };
    animations.push(animation);
    return animation;
  };
  // Anchors are resolved from rects, and every rect in jsdom is zero — so give
  // every element a box, or nothing is ever considered on screen.
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { left: 10, top: 20, width: 60, height: 90, right: 70, bottom: 110, x: 10, y: 20 } as DOMRect;
  };
});

afterEach(() => {
  delete (Element.prototype as { animate?: unknown }).animate;
});

/** A beat, applied the way React would see one arrive. */
function playedBeat(seq: number, card: Card): void {
  act(() => {
    setState({
      beat: {
        seq,
        events: [{ type: 'cardPlayed', playerId: GUEST_ID, card, resultingColor: 'red' }],
      },
    });
  });
}

describe('the flight layer, given a platform that animates', () => {
  it('puts one clone on the layer for a card somebody played', () => {
    const fixture = enterGame({ myTurn: true });
    renderApp();
    expect(document.querySelectorAll('.flight-layer__card')).toHaveLength(0);

    playedBeat(1, fixture.hand[0] as Card);
    expect(document.querySelectorAll('.flight-layer__card')).toHaveLength(1);
  });

  it('takes the clone away when the animation reports it is done', () => {
    const fixture = enterGame({ myTurn: true });
    renderApp();
    playedBeat(1, fixture.hand[0] as Card);
    expect(document.querySelectorAll('.flight-layer__card')).toHaveLength(1);

    act(() => {
      for (const animation of animations) {
        animation.finish();
      }
    });
    expect(document.querySelectorAll('.flight-layer__card')).toHaveLength(0);
  });

  it('takes the clone away when the animation is cancelled instead', () => {
    const fixture = enterGame({ myTurn: true });
    renderApp();
    playedBeat(1, fixture.hand[0] as Card);
    act(() => {
      for (const animation of animations) {
        animation.cancel();
      }
    });
    expect(document.querySelectorAll('.flight-layer__card')).toHaveLength(0);
  });

  it('leaves nothing focusable on a layer hidden from assistive technology', () => {
    /*
     * The draw pile's card is a real button, so a clone of it would be a tab stop
     * inside an `aria-hidden` subtree — focusable and announcing nothing, which is
     * worse than either hiding it or leaving it alone.
     */
    enterGame({ myTurn: true });
    renderApp();
    act(() => {
      setState({
        beat: { seq: 1, events: [{ type: 'cardDrawn', playerId: GUEST_ID, count: 2 }] },
      });
    });

    const layer = document.querySelector('.flight-layer');
    expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(layer?.querySelectorAll('button:not([disabled]), [tabindex]')).toHaveLength(0);
    for (const clone of document.querySelectorAll<HTMLElement>('.flight-layer__card')) {
      expect(clone.inert).toBe(true);
    }
  });

  it('marks the place a penalty landed, and clears the mark', () => {
    enterGame({ myTurn: true });
    renderApp();
    act(() => {
      setState({
        beat: { seq: 1, events: [{ type: 'drawStacked', playerId: GUEST_ID, total: 8 }] },
      });
    });
    const marks = document.querySelectorAll('.flight-layer__pulse');
    expect(marks).toHaveLength(1);
    // Intensity steps with the stake: eight cards owed is not two.
    expect(marks[0]).toHaveAttribute('data-intensity', '2');

    act(() => {
      for (const animation of animations) {
        animation.finish();
      }
    });
    expect(document.querySelectorAll('.flight-layer__pulse')).toHaveLength(0);
  });

  it('does not describe the same card twice when a beat is replayed', () => {
    const fixture = enterGame({ myTurn: true });
    renderApp();
    playedBeat(1, fixture.hand[0] as Card);
    expect(document.querySelectorAll('.flight-layer__card')).toHaveLength(1);

    // Same sequence number: a host replaying its log, or a beat catching up with a
    // card already in flight. The in-flight registry is what makes this harmless.
    playedBeat(1, fixture.hand[0] as Card);
    expect(document.querySelectorAll('.flight-layer__card')).toHaveLength(1);
  });

  it('says nothing at all about a move that arrived while the tab was hidden', () => {
    const fixture = enterGame({ myTurn: true });
    renderApp();
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      playedBeat(1, fixture.hand[0] as Card);
      // A hidden tab freezes its animations, so a clone made now would never
      // finish and never clean itself up.
      expect(document.querySelectorAll('.flight-layer__card')).toHaveLength(0);
    } finally {
      if (original) {
        Object.defineProperty(Document.prototype, 'visibilityState', original);
      }
    }
  });
});
