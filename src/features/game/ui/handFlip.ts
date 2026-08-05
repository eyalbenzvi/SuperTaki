import type { CardId } from '../engine/cards.ts';

/** Where one slot was, and how big the card inside it was. */
export interface SlotGeometry {
  readonly left: number;
  readonly top: number;
  /** The card's own width, which changes when the hand crosses a scale step. */
  readonly cardWidth: number;
}

export type SlotMap = ReadonlyMap<CardId, SlotGeometry>;

/** One slot's journey from where it was to where it now is. */
export interface SlotDelta {
  readonly cardId: CardId;
  readonly dx: number;
  readonly dy: number;
  /** Ratio of the old card width to the new one. `1` when nothing resized. */
  readonly scale: number;
}

/** Movement below this is not worth a composited layer. */
const NEGLIGIBLE_PX = 0.5;
const NEGLIGIBLE_SCALE = 0.01;

/**
 * What moved between two measurements of the hand.
 *
 * Pure, and separate from the component, because this is the only part of the
 * FLIP that can be tested: jsdom has no `ResizeObserver`, so the layout solver
 * returns unmeasured and every rect is zero — a component test can prove the hand
 * still renders, and can prove nothing whatever about the arithmetic.
 *
 * Cards present in both maps get a delta. A card that has just arrived has no
 * "before" and is left alone: it is flown in by the overlay instead, or simply
 * appears. A card that has gone needs nothing — the slot it occupied is already
 * gone with it.
 */
export function handDeltas(before: SlotMap, after: SlotMap): readonly SlotDelta[] {
  const deltas: SlotDelta[] = [];
  for (const [cardId, now] of after) {
    const was = before.get(cardId);
    if (!was) {
      continue;
    }
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    /*
     * Scale is part of the delta because the hand shrinks as it grows: paying a
     * four-card penalty can cross a step, and every card in the hand resizes at
     * the same moment as it moves. A translate-only FLIP would animate the
     * movement correctly and let the resize snap underneath it.
     */
    const scale = now.cardWidth > 0 ? was.cardWidth / now.cardWidth : 1;
    if (
      Math.abs(dx) < NEGLIGIBLE_PX &&
      Math.abs(dy) < NEGLIGIBLE_PX &&
      Math.abs(scale - 1) < NEGLIGIBLE_SCALE
    ) {
      continue;
    }
    deltas.push({ cardId, dx, dy, scale });
  }
  return deltas;
}

/**
 * Whether a measurement is worth keeping.
 *
 * The layout is solved in two commits: `--hand-scale` is computed inline from the
 * card count, so it lands one render *before* the solver's `--hand-strip` and
 * `--hand-card` do — and sometimes there is no second commit at all, because the
 * solver returns the previous layout when nothing about it changed. Measuring in
 * the intermediate commit would animate towards a position the browser is about to
 * replace, which reads as a double move.
 *
 * A settled measurement is one where every slot has a real position and a real
 * card width. Zero-width rects mean either the solver has not run or there is no
 * layout to read, and both are worth waiting for.
 */
export function isSettled(slots: SlotMap): boolean {
  if (slots.size === 0) {
    return false;
  }
  for (const geometry of slots.values()) {
    if (geometry.cardWidth <= 0) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the hand as a whole has moved, rather than its cards within it.
 *
 * A reflow moves cards inside a stationary hand. A viewport change moves the hand
 * itself — and a viewport can change height without changing anything the layout
 * solver solves for, so no re-render happens and nothing notices that every
 * remembered position is now wrong by the difference. Animating from those is how
 * cards come flying in from off the screen.
 */
export function handMoved(before: DOMRectReadOnly | null, after: DOMRectReadOnly): boolean {
  if (!before) {
    return false;
  }
  return (
    Math.abs(before.top - after.top) > NEGLIGIBLE_PX ||
    Math.abs(before.left - after.left) > NEGLIGIBLE_PX ||
    Math.abs(before.width - after.width) > NEGLIGIBLE_PX ||
    Math.abs(before.height - after.height) > NEGLIGIBLE_PX
  );
}

/**
 * Whether what was remembered about the hand is still comparable to it.
 *
 * Two ways it stops being. The hand can move as a whole — a viewport can get
 * shorter without changing anything the layout solver solves for, so nothing
 * re-renders while every remembered position is now wrong by the difference.
 *
 * And the *writing direction* can change, which mirrors the row wholesale:
 * measured at 1280 px wide, switching between English and Hebrew moves the
 * outermost card by 560 pixels. Nothing about the hand's own box changes when that
 * happens, and neither does the set of cards, so this is the only thing that
 * notices — and without it the next card played drags the whole hand across the
 * screen.
 */
export function geometryStale(
  before: { readonly box: DOMRectReadOnly; readonly direction: string } | null,
  after: { readonly box: DOMRectReadOnly; readonly direction: string },
): boolean {
  if (!before) {
    return false;
  }
  return before.direction !== after.direction || handMoved(before.box, after.box);
}

/** Whether the hand holds a different set of cards than it did. */
export function sameCards(before: SlotMap, after: SlotMap): boolean {
  if (before.size !== after.size) {
    return false;
  }
  for (const cardId of after.keys()) {
    if (!before.has(cardId)) {
      return false;
    }
  }
  return true;
}
