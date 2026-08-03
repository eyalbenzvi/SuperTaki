import type { ReactNode } from 'react';
import type { Card } from '../../engine/cards.ts';
import { isNumberCard } from '../../engine/cards.ts';

/**
 * Card symbols, drawn as chunky extruded shapes: a solid body in the suit
 * colour, a darker copy offset behind it, and a dark outline around both. The
 * offset copy is the whole trick — it is what makes a flat shape read as a
 * block sitting on the card.
 *
 * Every symbol is a solid path or a piece of text so the same treatment
 * applies to all of them; the colours come from CSS custom properties set by
 * the card, so one glyph works for four suits and for the multicoloured
 * colourless cards.
 */
function Extruded({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <svg className="glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g className="glyph__depth" transform="translate(1.15 1.35)">
        {children}
      </g>
      <g className="glyph__face">{children}</g>
    </svg>
  );
}

/** Heavy numeral, used for number cards and for the +2 / +3 counts. */
function Numeral({ value, x = 12, y = 18.6, size = 21 }: NumeralProps): ReactNode {
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={size} fontWeight="900" fontFamily="inherit">
      {value}
    </text>
  );
}

interface NumeralProps {
  readonly value: number | string;
  readonly x?: number;
  readonly y?: number;
  readonly size?: number;
}

/**
 * An open palm — the sign the printed Stop card uses. One continuous outline
 * with narrow notches between the fingers, so the outline never cuts across
 * the middle of the hand.
 */
function StopShape(): ReactNode {
  return (
    <path d="M7 21.5c-1.6-1.7-2.5-3.4-2.5-5.5v-3.2c0-1.5 1.8-1.9 2.5-.6l.7 1.4V6.8a1.3 1.3 0 0 1 2.6 0v3.4h.45V5.2a1.3 1.3 0 0 1 2.6 0v5h.45V4.8a1.3 1.3 0 0 1 2.6 0v5.4h.45V6.5a1.3 1.3 0 0 1 2.6 0v8.2c0 2.4-.8 4.6-2.1 6.5z" />
  );
}

function PlusShape(): ReactNode {
  return <path d="M9.6 2.6h4.8v7h7v4.8h-7v7H9.6v-7h-7V9.6h7z" />;
}

/** A small plus tucked beside the count, as on the printed +2 and +3. */
function CountedPlus({ value }: { readonly value: number }): ReactNode {
  return (
    <>
      <path d="M2.4 6.2h3.1V3.1h3.2v3.1h3.1v3.2H8.7v3.1H5.5V9.4H2.4z" />
      <Numeral value={value} x={15.6} y={21.4} size={17.5} />
    </>
  );
}

function DirectionShape(): ReactNode {
  return (
    <>
      <path d="M3.4 8.6 10 2.4v3.3h9.8v5.8h-3.4V9.1H10v3.4z" />
      <path d="M20.6 15.4 14 21.6v-3.3H4.2v-5.8h3.4v2.4H14v-3.4z" />
    </>
  );
}

/**
 * TAKI set two letters over two, the way it is printed on the card and on the
 * box. Slots let the Super Taki version colour each letter separately.
 */
function TakiWord({ multicolor = false }: { readonly multicolor?: boolean }): ReactNode {
  const letters = ['T', 'A', 'K', 'I'];
  return (
    <>
      {letters.map((letter, index) => (
        <text
          key={letter}
          className={multicolor ? `glyph__slot glyph__slot--${index}` : undefined}
          x={index % 2 === 0 ? 6.6 : 17.4}
          y={index < 2 ? 11.2 : 22}
          textAnchor="middle"
          fontSize="12.5"
          fontWeight="900"
          fontFamily="inherit"
        >
          {letter}
        </text>
      ))}
    </>
  );
}

/** Four stacked blocks, one per suit — the printed Change Colour card. */
function ColorChangeShape(): ReactNode {
  return (
    <>
      <rect className="glyph__slot glyph__slot--0" x="2.6" y="2.6" width="8.8" height="8.8" rx="1.6" />
      <rect className="glyph__slot glyph__slot--1" x="12.6" y="2.6" width="8.8" height="8.8" rx="1.6" />
      <rect className="glyph__slot glyph__slot--2" x="2.6" y="12.6" width="8.8" height="8.8" rx="1.6" />
      <rect className="glyph__slot glyph__slot--3" x="12.6" y="12.6" width="8.8" height="8.8" rx="1.6" />
    </>
  );
}

function KingShape(): ReactNode {
  return (
    <>
      <path d="M2.6 17.2 4.4 5.4l4.7 4.3L12 3.2l2.9 6.5 4.7-4.3 1.8 11.8z" />
      <rect x="3.6" y="18.6" width="16.8" height="3.2" rx="1.2" />
    </>
  );
}

/** The +3, snapped in half: the card that sends the three cards back. */
function BreakPlusThreeShape(): ReactNode {
  return (
    <>
      <path d="M1.6 5.6h2.9V2.7h3v2.9h2.9v3H7.5v2.9h-3V8.6H1.6z" />
      <Numeral value={3} x={15} y={20.6} size={16} />
      <path d="m22.4 1.6-8.1 9.1 3.3 1-6.2 10.7 1.4-7.6-3.2-.7z" />
    </>
  );
}

export function CardGlyph({ card }: { readonly card: Card }): ReactNode {
  if (isNumberCard(card)) {
    return (
      <Extruded>
        <Numeral value={card.value} />
      </Extruded>
    );
  }
  switch (card.kind) {
    case 'stop':
      return (
        <Extruded>
          <StopShape />
        </Extruded>
      );
    case 'plus':
      return (
        <Extruded>
          <PlusShape />
        </Extruded>
      );
    case 'plusTwo':
      return (
        <Extruded>
          <CountedPlus value={2} />
        </Extruded>
      );
    case 'direction':
      return (
        <Extruded>
          <DirectionShape />
        </Extruded>
      );
    case 'taki':
      return (
        <Extruded>
          <TakiWord />
        </Extruded>
      );
    case 'superTaki':
      return (
        <Extruded>
          <TakiWord multicolor />
        </Extruded>
      );
    case 'colorChange':
      return (
        <Extruded>
          <ColorChangeShape />
        </Extruded>
      );
    case 'king':
      return (
        <Extruded>
          <KingShape />
        </Extruded>
      );
    case 'plusThree':
      return (
        <Extruded>
          <CountedPlus value={3} />
        </Extruded>
      );
    case 'breakPlusThree':
      return (
        <Extruded>
          <BreakPlusThreeShape />
        </Extruded>
      );
  }
}
