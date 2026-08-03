/**
 * The block alphabet: nine numerals and the four letters of TAKI, drawn as
 * outlines rather than set in a typeface.
 *
 * No system font has the shape these want. The printed deck's digits are very
 * wide, very heavy, geometric, and cut off flat at every terminal — closer to
 * moulded plastic than to type — and a font at weight 900 extrudes into
 * something thin and generic. Drawn as polygons they also cost nothing to
 * extrude: `blockGeometry` turns any outline into a solid, so the numerals get the
 * same walls and internal edges as every other symbol.
 *
 * Everything is drawn on one body: 76 units tall, sitting on a baseline at
 * y = 76, with a stroke around 18 units thick. Widths differ per character, and
 * each is centred by the fit, so a 1 is not stretched to the width of an 8.
 */

import { arc, turn, type Shape } from './blockGeometry.ts';

const H = 76;

/**
 * A 2 and a 5 need real curves — flat facets there look broken rather than
 * geometric — so their bowls are arcs. The rest are straight-sided with cut
 * corners, which is what gives the set its moulded look.
 */
const DIGITS: Record<number, readonly Shape[]> = {
  1: [
    {
      outer: [
        [44, 0],
        [44, H],
        [24, H],
        [24, 26],
        [2, 38],
        [2, 14],
        [24, 0],
      ],
    },
  ],

  2: [
    {
      outer: [
        // Outer arch, from the angled left terminal over the top and down the
        // right, then the diagonal into a full-width foot.
        ...arc(28, 26, 27, 26, 200, 380, 12),
        [14, 57],
        [56, 57],
        [56, H],
        [0, H],
        [0, 57],
        // Back up the inside of the diagonal and around the counter.
        ...arc(28, 26, 11, 12, 20, -160, 10),
      ],
    },
  ],

  3: [
    {
      outer: [
        [12, 0],
        [44, 0],
        [56, 12],
        [56, 27],
        [46, 38],
        [56, 49],
        [56, 64],
        [44, H],
        [12, H],
        [0, 64],
        [0, 57],
        [36, 57],
        [36, 47],
        [14, 47],
        [14, 29],
        [36, 29],
        [36, 19],
        [0, 19],
        [0, 12],
      ],
    },
  ],

  4: [
    {
      outer: [
        [36, 0],
        [56, 0],
        [56, 50],
        [64, 50],
        [64, 66],
        [56, 66],
        [56, H],
        [36, H],
        [36, 66],
        [0, 66],
        [0, 50],
      ],
      holes: [
        [
          [36, 24],
          [36, 50],
          [17, 50],
        ],
      ],
    },
  ],

  5: [
    {
      outer: [
        [0, 0],
        [54, 0],
        [54, 18],
        [18, 18],
        [18, 30],
        [34, 30],
        [47, 36],
        [56, 50],
        [56, 60],
        [46, 71],
        [32, H],
        [15, H],
        [3, 68],
        [14, 54],
        [26, 60],
        [38, 54],
        [40, 46],
        [0, 46],
      ],
    },
  ],

  6: [
    {
      // A flat-cut terminal at the top, a stroke running down-left, and a bowl
      // hung off the bottom of it. The bowl is cut in facets rather than
      // rounded: it keeps the counter big enough to stay open once its own
      // inner wall has eaten into it, which a true circle does not.
      outer: [
        [24, 0],
        [46, 0],
        [32, 27],
        [46, 32],
        [55, 44],
        [55, 60],
        [45, 73],
        [28, H],
        [12, 72],
        [1, 59],
        [0, 46],
      ],
      holes: [
        [
          [22, 42],
          [36, 42],
          [42, 48],
          [42, 60],
          [36, 66],
          [22, 66],
          [16, 60],
          [16, 48],
        ],
      ],
    },
  ],

  7: [
    {
      outer: [
        [0, 0],
        [54, 0],
        [54, 15],
        [30, H],
        [10, H],
        [34, 20],
        [0, 20],
      ],
    },
  ],

  8: [
    {
      // A small bowl over a larger one, pinched where they meet.
      outer: [
        [18, 0],
        [38, 0],
        [52, 10],
        [52, 25],
        [44, 36],
        [54, 46],
        [54, 64],
        [40, H],
        [16, H],
        [2, 64],
        [2, 46],
        [12, 36],
        [4, 25],
        [4, 10],
      ],
      holes: [
        [
          [20, 14],
          [36, 14],
          [40, 20],
          [40, 27],
          [36, 32],
          [20, 32],
          [16, 27],
          [16, 20],
        ],
        [
          [18, 46],
          [38, 46],
          [42, 52],
          [42, 61],
          [38, 66],
          [18, 66],
          [14, 61],
          [14, 52],
        ],
      ],
    },
  ],
};

/** A 9 is a 6 stood on its head, as it is in most geometric alphabets. */
DIGITS[9] = turn(DIGITS[6]!, 27.5, 38);

export function digit(value: number): readonly Shape[] {
  return DIGITS[value] ?? DIGITS[1]!;
}

/* Letters -------------------------------------------------------------------- */

/**
 * The four letters of the wordmark. Nearly as wide as they are tall and very
 * heavy — that squareness is most of the mark's character, and a letter drawn
 * at ordinary text proportions looks weedy the moment it is extruded.
 */
const LETTERS: Record<string, readonly Shape[]> = {
  T: [
    {
      outer: [
        [0, 0],
        [66, 0],
        [66, 21],
        [44, 21],
        [44, H],
        [22, H],
        [22, 21],
        [0, 21],
      ],
    },
  ],
  A: [
    {
      outer: [
        [22, 0],
        [44, 0],
        [66, H],
        [45, H],
        [41, 60],
        [25, 60],
        [21, H],
        [0, H],
      ],
      // Roomy on purpose: a counter this size still shows white once its own
      // inner wall has taken a bite out of it.
      holes: [
        [
          [33, 16],
          [22, 48],
          [44, 48],
        ],
      ],
    },
  ],
  K: [
    {
      outer: [
        [0, 0],
        [22, 0],
        [22, 28],
        [45, 0],
        [73, 0],
        [42, 36],
        [75, H],
        [48, H],
        [27, 48],
        [22, 54],
        [22, H],
        [0, H],
      ],
    },
  ],
  I: [
    {
      outer: [
        [0, 0],
        [24, 0],
        [24, H],
        [0, H],
      ],
    },
  ],
};

export function letter(character: string): readonly Shape[] {
  return LETTERS[character.toUpperCase()] ?? LETTERS.I!;
}

/* Placement ------------------------------------------------------------------ */

function extent(shapes: readonly Shape[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    for (const [x, y] of shape.outer) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** How wide a character sets at a given cap height, for laying out a word. */
export function widthAt(shapes: readonly Shape[], capHeight: number): number {
  const box = extent(shapes);
  return (box.w * capHeight) / H;
}

/**
 * Sets a character at a given cap height with its middle at (cx, cy). Used to
 * arrange TAKI in its block of four, where every letter must share a cap height
 * however wide or narrow it happens to be.
 */
export function setAt(shapes: readonly Shape[], cx: number, cy: number, capHeight: number): Shape[] {
  const box = extent(shapes);
  const s = capHeight / H;
  const ox = cx - (box.x + box.w / 2) * s;
  const oy = cy - (box.y + box.h / 2) * s;
  const move = ([x, y]: readonly [number, number]): readonly [number, number] => [x * s + ox, y * s + oy];
  return shapes.map((shape) => ({
    outer: shape.outer.map(move),
    ...(shape.holes ? { holes: shape.holes.map((hole) => hole.map(move)) } : {}),
  }));
}
