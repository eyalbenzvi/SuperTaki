import type { ReactNode } from 'react';
import type { Card } from '../../engine/cards.ts';
import { isNumberCard } from '../../engine/cards.ts';

/**
 * Original inline-SVG symbols, one per card kind.
 * These carry the meaning that colour alone must never carry.
 */
function StopGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M8.2 2h7.6L22 8.2v7.6L15.8 22H8.2L2 15.8V8.2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <rect x="6.5" y="10.6" width="11" height="2.8" rx="1.4" fill="currentColor" />
    </svg>
  );
}

function PlusGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="10.2" y="3" width="3.6" height="18" rx="1.8" fill="currentColor" />
      <rect x="3" y="10.2" width="18" height="3.6" rx="1.8" fill="currentColor" />
    </svg>
  );
}

function DirectionGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M5 9a7 7 0 0 1 12-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M17 3.5V8h-4.5z" fill="currentColor" />
      <path
        d="M19 15a7 7 0 0 1-12 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M7 20.5V16h4.5z" fill="currentColor" />
    </svg>
  );
}

function TakiGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M6 4l6 8-6 8M13 4l6 8-6 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SuperTakiGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 1.8l2.5 5.4 5.9.7-4.4 4 1.2 5.8L12 15l-5.2 2.7L8 11.9l-4.4-4 5.9-.7z"
        fill="currentColor"
      />
      <path
        d="M9.4 21.6l2.6-3 2.6 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ColorChangeGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9.4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 2.6A9.4 9.4 0 0 1 21.4 12H12z" fill="currentColor" />
      <path d="M12 12h9.4A9.4 9.4 0 0 1 12 21.4z" fill="currentColor" opacity="0.55" />
      <path d="M12 12v9.4A9.4 9.4 0 0 1 2.6 12z" fill="currentColor" opacity="0.3" />
    </svg>
  );
}

export function CardGlyph({ card }: { readonly card: Card }): ReactNode {
  if (isNumberCard(card)) {
    return <span aria-hidden="true">{card.value}</span>;
  }
  switch (card.kind) {
    case 'stop':
      return <StopGlyph />;
    case 'plus':
      return <PlusGlyph />;
    case 'direction':
      return <DirectionGlyph />;
    case 'taki':
      return <TakiGlyph />;
    case 'superTaki':
      return <SuperTakiGlyph />;
    case 'colorChange':
      return <ColorChangeGlyph />;
  }
}
