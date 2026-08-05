/**
 * How the player's hand is arranged across the width it has.
 *
 * Pure arithmetic, kept out of the component so the one thing that decides
 * whether a player can see all of their cards can be tested directly rather than
 * through a layout engine.
 */

/**
 * The narrowest strip of a card that still owns its own centre.
 *
 * A card is a button, and a tap lands in the middle of it. If the visible strip
 * were narrower than half a card, the neighbour lapping over it would own the
 * middle of the card underneath, and a confident tap would play the wrong card —
 * irreversibly, in front of everyone. Just over half keeps every centre honest.
 */
export const MIN_STRIP_RATIO = 0.52;

/** The gap between cards in a hand that has room to spread out, in px. */
export const SPREAD_GAP_PX = 8;

/** Kept clear of the edges so a card never sits flush against them, in px. */
export const EDGE_MARGIN_PX = 4;

export interface HandLayout {
  /** Cards per row. `0` while nothing has been measured yet. */
  readonly perRow: number;
  /** Distance from one card's leading edge to the next, in px. */
  readonly strip: number;
  /** The measured width of a card, in px. */
  readonly card: number;
}

/** Before anything has been measured: the stylesheet's own defaults apply. */
export const UNMEASURED: HandLayout = { perRow: 0, strip: 0, card: 0 };

/**
 * How much of its full size a card is drawn at, for a hand of `count`.
 *
 * A hand of fifteen at full size is two rows about 200 px tall, which on a 660 px
 * phone leaves the table too little to draw itself in — the piles came out cut in
 * half, which is what a player reported. Bringing the cards down a little as the
 * hand grows buys that space back, and it buys it from the part of the screen
 * that has the most of it: a big hand is mostly overlap anyway.
 *
 * A function of the count alone, deliberately. Scaling from the measured width
 * instead would feed the new card size back into the next measurement, and a hand
 * that sits on the boundary would oscillate between two sizes for ever.
 *
 * Four steps rather than two. The floor and the ceiling are unchanged; what
 * changed is the size of the largest single jump, from fourteen per cent down to
 * about seven. That was tolerable while the resize was instantaneous and read as
 * nothing at all, but the hand now animates between layouts — and an animated
 * fourteen per cent shrug is something you can watch happen.
 */
export function handCardScale(count: number): number {
  if (count <= 8) {
    return 1;
  }
  if (count <= 10) {
    return 0.93;
  }
  if (count <= 12) {
    return 0.86;
  }
  return count <= 15 ? 0.81 : 0.76;
}

/**
 * Solves how many cards fit on a row, and how far apart they sit.
 *
 * The hand used to be a single row that scrolled sideways once it stopped
 * fitting, which meant a hand of ten had cards off the edge of the screen and no
 * way to see them but a swipe nobody discovered. So the row is measured instead:
 * cards spread out when there is room, close up to the overlap floor when there
 * is not, and then **wrap onto another row** rather than off the screen.
 *
 * Rows are balanced — eleven cards go 6 + 5, never 9 + 2 — because a nearly
 * empty second row reads as a rendering fault rather than as a hand.
 */
export function solveHandLayout(available: number, card: number, count: number): HandLayout {
  if (available <= 0 || card <= 0 || count <= 0) {
    return UNMEASURED;
  }
  const floor = card * MIN_STRIP_RATIO;
  // How many cards a single row can hold: the first one whole, then one strip per
  // card after it.
  const capacity = card <= available ? Math.floor((available - card) / floor) + 1 : 1;
  const rows = Math.ceil(count / Math.max(1, Math.min(count, capacity)));
  const perRow = Math.ceil(count / rows);
  if (perRow <= 1) {
    return { perRow: 1, strip: card, card };
  }
  const fitted = (available - card) / (perRow - 1);
  const strip = Math.min(card + SPREAD_GAP_PX, Math.max(floor, fitted));
  return { perRow, strip, card };
}

/** How many rows {@link solveHandLayout} produces for a hand of `count`. */
export function rowCount(layout: HandLayout, count: number): number {
  return layout.perRow > 0 ? Math.ceil(count / layout.perRow) : 1;
}
