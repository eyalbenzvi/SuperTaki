import type { ReactNode } from 'react';
import type { Card } from '../../engine/cards.ts';
import { isNumberCard } from '../../engine/cards.ts';

/**
 * Card symbols, drawn as solid blocks standing on the card.
 *
 * Each symbol is defined once as a flat silhouette, then stamped a dozen times
 * along a fixed down-and-left vector before the bright front face is drawn on
 * top. The stack of stamps *is* the extruded body: because every copy is a
 * little further down-left and each is painted before the one in front of it,
 * only the outer edge of the stack keeps its outline, and the block reads as a
 * solid object rather than a flat shape with a shadow behind it.
 *
 * Everything is drawn in a 100×100 box. Colours come from CSS custom
 * properties the card sets, so one drawing serves four suits, and the
 * `glyph__slot--n` class picks a suit per part for the multicoloured cards.
 */
const DEPTH_STEPS = 12;
const STEP_X = -0.78;
const STEP_Y = 1.02;

interface ExtrudedProps {
  readonly children: ReactNode;
  /** Corner indices are too small for the block to read; draw them flat. */
  readonly flat?: boolean;
}

function Extruded({ children, flat = false }: ExtrudedProps): ReactNode {
  // Furthest stamp first, so each copy paints over the outline of the one
  // behind it and only the outer edge of the block keeps its line.
  const depth = flat ? [] : Array.from({ length: DEPTH_STEPS }, (_, index) => DEPTH_STEPS - index);

  return (
    <svg className="glyph" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      {depth.map((step) => (
        <g
          key={step}
          className="glyph__depth"
          transform={`translate(${(step * STEP_X).toFixed(2)} ${(step * STEP_Y).toFixed(2)})`}
        >
          {children}
        </g>
      ))}
      <g className="glyph__face">{children}</g>
    </svg>
  );
}

interface GlyphTextProps {
  readonly children: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly slot?: number;
}

/** Numerals and letters are set in the heaviest weight available and extruded. */
function GlyphText({ children, x, y, size, slot }: GlyphTextProps): ReactNode {
  return (
    <text
      className={slot === undefined ? undefined : `glyph__slot--${slot}`}
      x={x}
      y={y}
      textAnchor="middle"
      fontSize={size}
      fontWeight="900"
      fontFamily="inherit"
    >
      {children}
    </text>
  );
}

/** An open palm, the sign the printed Stop card uses. */
function StopShape(): ReactNode {
  return (
    <>
      <path d="M27 93c-7-9-11-19-11-29V44c0-8 9-10 13-3l3 6V27a6 6 0 0 1 12 0v18h5V19a6 6 0 0 1 12 0v26h5V16a6 6 0 0 1 12 0v29h5V23a6 6 0 0 1 12 0v34c0 12-4 24-11 33z" />
      <path d="M22 52c-8 1-14 8-13 16s9 13 17 11l9-3-4-22z" />
    </>
  );
}

function PlusShape(): ReactNode {
  return <path d="M36 8h28v28h28v28H64v28H36V64H8V36h28z" />;
}

/** A numeral with the small plus that marks the take-cards pair. */
function CountedPlus({ value, slot }: { readonly value: number; readonly slot?: number }): ReactNode {
  return (
    <>
      <GlyphText x={44} y={84} size={80} slot={slot}>
        {String(value)}
      </GlyphText>
      <path
        className={slot === undefined ? undefined : 'glyph__slot--0'}
        d="M74 6h13v13h13v13H87v13H74V32H61V19h13z"
      />
    </>
  );
}

/** Two interlocking block arrows, the printed Change Direction card. */
function DirectionShape(): ReactNode {
  return (
    <>
      <path d="M14 26h46V14l24 21-24 21V44H14z" />
      <path d="M86 62H40V50L16 71l24 21V80h46z" />
    </>
  );
}

/**
 * TAKI set two letters over two, as it is printed on the card. `multicolor`
 * gives each letter its own suit, which is what the Super Taki card does.
 */
const TAKI_LETTERS: ReadonlyArray<readonly [string, number, number, number]> = [
  // letter, x, baseline, suit slot
  ['T', 26, 42, 2],
  ['A', 74, 42, 0],
  ['K', 26, 90, 1],
  ['I', 74, 90, 3],
];

function TakiWord({ multicolor = false }: { readonly multicolor?: boolean }): ReactNode {
  return (
    <>
      {TAKI_LETTERS.map(([letter, x, y, slot]) => (
        <GlyphText key={letter} x={x} y={y} size={44} slot={multicolor ? slot : undefined}>
          {letter}
        </GlyphText>
      ))}
    </>
  );
}

/**
 * One isometric cube: a rhombus lid with a left and a right wall under it. The
 * three faces take three shades of the same suit, which is what makes it read
 * as a solid rather than a hexagon.
 *
 * These are drawn face by face instead of being stamped like the other
 * symbols, because a cube's depth runs straight down while every other symbol
 * leans down-left.
 */
function Cube({ x, y, slot }: { readonly x: number; readonly y: number; readonly slot: number }): ReactNode {
  const w = 24;
  const h = 13.5;
  const d = 24;
  return (
    <g className={`cube glyph__slot--${slot}`} transform={`translate(${x} ${y})`}>
      <path className="cube__top" d={`M0 ${-h} ${w} 0 0 ${h} ${-w} 0z`} />
      <path className="cube__left" d={`M${-w} 0 0 ${h} 0 ${h + d} ${-w} ${d}z`} />
      <path className="cube__right" d={`M${w} 0 ${w} ${d} 0 ${h + d} 0 ${h}z`} />
    </g>
  );
}

/** A stack of blocks in the four suits — the printed Change Colour card. */
function ColorChangeShape(): ReactNode {
  return (
    <>
      <Cube x={26} y={42} slot={2} />
      <Cube x={74} y={42} slot={3} />
      <Cube x={50} y={19} slot={0} />
    </>
  );
}

function KingShape(): ReactNode {
  return (
    <>
      <path d="M10 70 19 22l17 19L50 10l14 31 17-19 9 48z" />
      <path d="M13 74h74v18H13z" />
    </>
  );
}

/** The +3, cracked open: the card that sends the three cards back. */
function BreakPlusThreeShape(): ReactNode {
  return (
    <>
      <GlyphText x={46} y={84} size={80} slot={3}>
        3
      </GlyphText>
      <path className="glyph__slot--1" d="M96 6 66 38l11 4-24 36 6-28-11-3z" />
    </>
  );
}

export interface CardGlyphProps {
  readonly card: Card;
  /** Renders the flat silhouette only, for the corner indices. */
  readonly flat?: boolean;
}

export function CardGlyph({ card, flat = false }: CardGlyphProps): ReactNode {
  if (isNumberCard(card)) {
    return (
      <Extruded flat={flat}>
        <GlyphText x={50} y={84} size={88}>
          {String(card.value)}
        </GlyphText>
      </Extruded>
    );
  }
  switch (card.kind) {
    case 'stop':
      return (
        <Extruded flat={flat}>
          <StopShape />
        </Extruded>
      );
    case 'plus':
      return (
        <Extruded flat={flat}>
          <PlusShape />
        </Extruded>
      );
    case 'plusTwo':
      return (
        <Extruded flat={flat}>
          <CountedPlus value={2} />
        </Extruded>
      );
    case 'direction':
      return (
        <Extruded flat={flat}>
          <DirectionShape />
        </Extruded>
      );
    case 'taki':
      return (
        <Extruded flat={flat}>
          <TakiWord />
        </Extruded>
      );
    case 'superTaki':
      return (
        <Extruded flat={flat}>
          <TakiWord multicolor />
        </Extruded>
      );
    case 'colorChange':
      return (
        <svg className="glyph glyph--solid" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <ColorChangeShape />
        </svg>
      );
    case 'king':
      return (
        <Extruded flat={flat}>
          <KingShape />
        </Extruded>
      );
    case 'plusThree':
      return (
        <Extruded flat={flat}>
          <CountedPlus value={3} slot={1} />
        </Extruded>
      );
    case 'breakPlusThree':
      return (
        <Extruded flat={flat}>
          <BreakPlusThreeShape />
        </Extruded>
      );
  }
}
