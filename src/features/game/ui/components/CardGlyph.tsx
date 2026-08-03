import type { ReactNode } from 'react';
import type { Card } from '../../engine/cards.ts';
import { isNumberCard } from '../../engine/cards.ts';
import { BlockArt } from '../../../../lib/BlockArt.tsx';
import { arc, turn, type Box, type Part, type Pt, type Shape } from '../../../../lib/blockGeometry.ts';
import { digit, letter, setAt, widthAt } from '../../../../lib/blockAlphabet.ts';

/**
 * The card symbols.
 *
 * Each one is a solid object: an outline drawn in a 100×100 box, which
 * `blockGeometry` extrudes down and to the left into a bright front face with its
 * own side and bottom walls, every edge outlined. Symbols made of several
 * pieces — a numeral and the plus beside it, the four letters of TAKI — are
 * given as separate parts so each is a solid in its own right and the pieces
 * overlap the way real blocks would.
 *
 * The one exception is Change Colour, whose cubes are seen straight on in
 * isometric rather than leaning, exactly as they are printed; those are drawn
 * face by face here.
 */

const BOX: Box = { x: 3, y: 3, w: 94, h: 94 };

/* Outlines ------------------------------------------------------------------- */

/** A blunt cross, the take-cards mark. Drawn once, reused at three sizes. */
const CROSS: readonly Shape[] = [
  {
    outer: [
      [34, 0],
      [66, 0],
      [66, 34],
      [100, 34],
      [100, 66],
      [66, 66],
      [66, 100],
      [34, 100],
      [34, 66],
      [0, 66],
      [0, 34],
      [34, 34],
    ],
  },
];

/**
 * An open palm: four fingers with domed tips over a broad hand, thumb out to
 * the left. The tips are arcs — a hand is the one symbol in the deck that is
 * not built out of straight cuts, and faceting it makes it read as a leaf.
 */
const PALM: readonly Shape[] = [
  {
    outer: [
      [30, 62],
      ...arc(38, 28, 7.5, 7.5, 180, 360, 6),
      [46, 56],
      ...arc(54, 19, 7.5, 7.5, 180, 360, 6),
      [62, 55],
      ...arc(70, 25, 7, 7, 180, 360, 6),
      [78, 58],
      ...arc(85, 37, 6.5, 6.5, 180, 360, 6),
      [95, 66],
      [90, 86],
      [74, 98],
      [52, 100],
      [34, 94],
      [26, 86],
      // The thumb: a lobe of its own, set off from the palm by a real notch so
      // the hand does not read as a mitten.
      [14, 90],
      [3, 84],
      [0, 72],
      [8, 63],
      [22, 62],
    ],
  },
];

/** A block arrow pointing right; the pair below is this one and its opposite. */
const ARROW: readonly Shape[] = [
  {
    outer: [
      [6, 24],
      [54, 24],
      [54, 8],
      [94, 34],
      [54, 60],
      [54, 44],
      [6, 44],
    ],
  },
];

/** Two arrows head to tail, the Change Direction mark. */
const ARROWS: readonly Shape[] = [...ARROW, ...turn(ARROW, 50, 54)];

/**
 * Three points over two valleys, flaring outwards as they rise, sitting on a
 * rim — the shape everyone draws when they draw a crown.
 */
const CROWN: readonly Shape[] = [
  {
    outer: [
      [3, 11],
      [27, 43],
      [50, 3],
      [73, 43],
      [97, 11],
      [88, 69],
      [12, 69],
    ],
  },
];

/** The rim under the points, a little wider than the body it carries. */
const CROWN_RIM: readonly Shape[] = [
  {
    outer: [
      [5, 66],
      [95, 66],
      [95, 93],
      [5, 93],
    ],
  },
];

/** The stone set in the rim, raised proud of it. */
const JEWEL: readonly Shape[] = [
  {
    outer: [
      [50, 68],
      [59, 79],
      [50, 90],
      [41, 79],
    ],
  },
];

/* Compositions --------------------------------------------------------------- */

function scaleShapes(shapes: readonly Shape[], factor: number, dx: number, dy: number): Shape[] {
  const move = ([x, y]: Pt): Pt => [x * factor + dx, y * factor + dy];
  return shapes.map((shape) => ({
    outer: shape.outer.map(move),
    ...(shape.holes ? { holes: shape.holes.map((hole) => hole.map(move)) } : {}),
  }));
}

/** A numeral with the small cross that marks a take-cards card. */
function counted(value: number, numeralSlot?: number): Part[] {
  return [
    {
      shapes: scaleShapes(digit(value), 1, 0, 22),
      ...(numeralSlot === undefined ? {} : { slot: numeralSlot }),
    },
    { shapes: scaleShapes(CROSS, 0.36, 62, 0), slot: numeralSlot === undefined ? undefined : 0 },
  ];
}

/**
 * TAKI in a block of four, as the card prints it. Each letter is its own solid,
 * so the two on the right correctly overlap the two on the left; `multicolor`
 * gives each one a suit, which is what the Super Taki card does.
 */
function takiBlock(multicolor: boolean): Part[] {
  const cap = 44;
  // Wide enough that a letter's wall lands beside its neighbour rather than on
  // top of it: the four have to stay four letters, not one coloured mass.
  const gap = 9;
  const rows: ReadonlyArray<readonly [string, number][]> = [
    [
      ['T', 2],
      ['A', 0],
    ],
    [
      ['K', 1],
      ['I', 3],
    ],
  ];
  return rows.flatMap((row, rowIndex) => {
    const widths = row.map(([character]) => widthAt(letter(character), cap));
    const total = widths.reduce((sum, w) => sum + w, 0) + gap * (row.length - 1);
    let cursor = -total / 2;
    return row.map(([character, slot], index) => {
      const w = widths[index]!;
      const part: Part = {
        shapes: setAt(letter(character), cursor + w / 2, rowIndex * (cap + gap), cap),
        ...(multicolor ? { slot } : {}),
      };
      cursor += w + gap;
      return part;
    });
  });
}

/* Change Colour -------------------------------------------------------------- */

/**
 * Half-width, half-height and wall height of one cube, and the step between
 * cubes. The step is wider than the cube, so the four stand apart instead of
 * fusing into one block with four coloured lids — the printed card floats them
 * the same way, and it is the only way each cube keeps all three of its faces.
 */
const CUBE = { w: 19, h: 11, d: 21, stepX: 28.5, stepY: 16.5 };

/**
 * One cube: a rhombus lid over a left and a right wall. It borrows the same
 * three tones the extruded symbols use — face, side, bottom — so a cube and a
 * numeral look like they are made of the same stuff.
 */
function CubeBlock({
  x,
  y,
  slot,
}: {
  readonly x: number;
  readonly y: number;
  readonly slot: number;
}): ReactNode {
  const { w, h, d } = CUBE;
  return (
    <g className={`glyph__slot--${slot}`} transform={`translate(${x} ${y})`}>
      <path className="glyph__wall glyph__wall--mid" d={`M${-w} 0 0 ${h} 0 ${h + d} ${-w} ${d}z`} />
      <path className="glyph__wall glyph__wall--deep" d={`M${w} 0 ${w} ${d} 0 ${h + d} 0 ${h}z`} />
      <path className="glyph__face" d={`M0 ${-h} ${w} 0 0 ${h} ${-w} 0z`} />
    </g>
  );
}

/**
 * Four cubes on a two-by-two floor, one suit each, painted back to front the
 * way an isometric stack has to be.
 */
function CubeStack(): ReactNode {
  const { stepX, stepY } = CUBE;
  // Floor cell (i, j), and the suit standing on it. Painted in order of i + j,
  // which for an isometric floor is back to front.
  const cells: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0],
    [1, 0, 1],
    [0, 1, 3],
    [1, 1, 2],
  ];
  return (
    <g transform="translate(50 23)">
      {cells.map(([i, j, slot]) => (
        <CubeBlock key={`${i}-${j}`} x={(i - j) * stepX} y={(i + j) * stepY} slot={slot} />
      ))}
    </g>
  );
}

/** The corner index for Change Colour: the four suits, small enough to read. */
function CubeIndex(): ReactNode {
  const quarters: ReadonlyArray<readonly [string, number]> = [
    ['M50 6 94 50 50 50z', 0],
    ['M94 50 50 94 50 50z', 1],
    ['M50 94 6 50 50 50z', 2],
    ['M6 50 50 6 50 50z', 3],
  ];
  return (
    <>
      {quarters.map(([d, slot]) => (
        <path key={slot} className={`glyph__face glyph__slot--${slot}`} d={d} />
      ))}
    </>
  );
}

/* Symbol table --------------------------------------------------------------- */

interface Drawing {
  readonly parts: readonly Part[];
  /** A crowded drawing leans less, or the pieces bury each other. */
  readonly depth?: Pt;
}

const SHALLOW: Pt = [-6, 7.2];

function drawingFor(card: Card): Drawing {
  if (isNumberCard(card)) return { parts: [{ shapes: digit(card.value) }] };
  switch (card.kind) {
    case 'stop':
      return { parts: [{ shapes: PALM }] };
    case 'plus':
      return { parts: [{ shapes: CROSS }] };
    case 'plusTwo':
      return { parts: counted(2), depth: SHALLOW };
    case 'direction':
      return { parts: [{ shapes: [ARROWS[0]!] }, { shapes: [ARROWS[1]!] }], depth: SHALLOW };
    case 'taki':
      return { parts: takiBlock(false), depth: SHALLOW };
    case 'superTaki':
      return { parts: takiBlock(true), depth: SHALLOW };
    case 'king':
      return {
        parts: [{ shapes: CROWN }, { shapes: CROWN_RIM, z: -1e6 }, { shapes: JEWEL, slot: 4, z: -2e6 }],
      };
    case 'plusThree':
      return { parts: counted(3), depth: SHALLOW };
    case 'breakPlusThree':
      return {
        parts: [
          { shapes: tilt(THREE_TOP, -9, -6, -6) },
          { shapes: tilt(THREE_BOTTOM, 8, 7, 7) },
          { shapes: SHARDS },
        ],
        depth: SHALLOW,
      };
    default:
      return { parts: [{ shapes: CROSS }] };
  }
}

/**
 * Corner indices are a few millimetres across. The full drawing does not
 * survive that, so the busiest symbols show a stand-in there — a single T for
 * TAKI, the four suits as a quartered diamond for Change Colour — the way the
 * printed deck shrinks its own indices down to a mark.
 */
function indexFor(card: Card): Drawing | null {
  if (isNumberCard(card)) return null;
  switch (card.kind) {
    case 'taki':
      return { parts: [{ shapes: letter('T') }] };
    case 'superTaki':
      return { parts: takiBlock(true) };
    default:
      return null;
  }
}

/*
 * The +3 Breaker: the numeral snapped in two.
 *
 * Both halves are traced off the alphabet's 3 — same outline, same terminals —
 * and parted along one ragged fracture, each half keeping the identical run of
 * points so no material is gained or lost across the join. The break runs
 * through the waist, where the numeral is already at its thinnest and where a
 * real one would give way. Pulling the halves apart and canting them opposite
 * ways is what actually says "broken"; a line drawn over an intact numeral
 * only ever reads as a line drawn over an intact numeral.
 */
const FRACTURE: readonly Pt[] = [
  [49, 44],
  [40, 38],
  [31, 45],
  [22, 39],
  [14, 45],
];

const THREE_TOP: readonly Shape[] = [
  {
    outer: [
      [12, 0],
      [44, 0],
      [56, 12],
      [56, 27],
      [46, 38],
      ...FRACTURE,
      [14, 29],
      [36, 29],
      [36, 19],
      [0, 19],
      [0, 12],
    ],
  },
];

const THREE_BOTTOM: readonly Shape[] = [
  {
    outer: [
      ...[...FRACTURE].reverse(),
      [56, 49],
      [56, 64],
      [44, 76],
      [12, 76],
      [0, 64],
      [0, 57],
      [36, 57],
      [36, 47],
      [14, 47],
    ],
  },
];

/** A chip thrown clear of the break, small enough to read as debris. */
const SHARDS: readonly Shape[] = [
  {
    outer: [
      [62, 29],
      [71, 34],
      [64, 40],
    ],
  },
];

/** Rotates about a point and then shifts, so a piece can be knocked askew. */
function tilt(shapes: readonly Shape[], degrees: number, dx: number, dy: number): Shape[] {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const [cx, cy] = [28, 38];
  const move = ([x, y]: Pt): Pt => [
    cx + (x - cx) * cos - (y - cy) * sin + dx,
    cy + (x - cx) * sin + (y - cy) * cos + dy,
  ];
  return shapes.map((shape) => ({
    outer: shape.outer.map(move),
    ...(shape.holes ? { holes: shape.holes.map((hole) => hole.map(move)) } : {}),
  }));
}

export interface CardGlyphProps {
  readonly card: Card;
  /** Renders the front face alone, for the corner indices. */
  readonly flat?: boolean;
}

export function CardGlyph({ card, flat = false }: CardGlyphProps): ReactNode {
  if (card.kind === 'colorChange') {
    return (
      <svg className="glyph" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        {flat ? <CubeIndex /> : <CubeStack />}
      </svg>
    );
  }
  const drawing = (flat ? indexFor(card) : null) ?? drawingFor(card);
  return (
    <svg className="glyph" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <BlockArt
        parts={drawing.parts}
        box={BOX}
        flat={flat}
        {...(drawing.depth ? { depth: drawing.depth } : {})}
      />
    </svg>
  );
}
