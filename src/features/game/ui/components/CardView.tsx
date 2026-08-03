import type { ReactNode } from 'react';
import type { Translator } from '../../../../i18n/index.ts';
import { cardColor, isNumberCard, type Card } from '../../engine/cards.ts';
import { cardFaceLabel, describeCard } from '../cardText.ts';
import { CardGlyph } from './CardGlyph.tsx';

export type CardSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASS: Record<CardSize, string> = {
  sm: 'card--sm',
  md: '',
  lg: 'card--lg',
  xl: 'card--xl',
};

function colorClass(card: Card): string {
  const color = cardColor(card);
  return color ? `card--${color}` : 'card--wild';
}

export interface CardFaceProps {
  readonly card: Card;
  readonly t: Translator;
  readonly size?: CardSize;
}

/** Non-interactive card face, e.g. the top of the discard pile. */
export function CardFace({ card, t, size = 'md' }: CardFaceProps): ReactNode {
  return (
    <div
      className={`card ${colorClass(card)} ${SIZE_CLASS[size]}`.trim()}
      role="img"
      aria-label={describeCard(t, card)}
    >
      <CardBody card={card} t={t} />
    </div>
  );
}

function CardBody({ card, t }: { readonly card: Card; readonly t: Translator }): ReactNode {
  return (
    <>
      {isNumberCard(card) ? (
        <span className="card__corner" aria-hidden="true">
          {card.value}
        </span>
      ) : null}
      <span className="card__glyph">
        <CardGlyph card={card} />
      </span>
      <span className="card__label" aria-hidden="true">
        {cardFaceLabel(t, card)}
      </span>
    </>
  );
}

export interface PlayableCardProps {
  readonly card: Card;
  readonly t: Translator;
  readonly playable: boolean;
  readonly onPlay: (card: Card) => void;
  readonly size?: CardSize;
  /** Explains why the card is disabled, for assistive technology. */
  readonly disabledReason?: string;
}

/**
 * A card in the local player's hand.
 * Always a real button so keyboard and screen-reader users can play it; illegal
 * cards are disabled *and* explained rather than silently inert.
 */
export function PlayableCard({
  card,
  t,
  playable,
  onPlay,
  size = 'md',
  disabledReason,
}: PlayableCardProps): ReactNode {
  const description = describeCard(t, card);
  return (
    <button
      type="button"
      className={`card ${colorClass(card)} ${SIZE_CLASS[size]} ${
        playable ? 'card--playable' : 'card--dimmed'
      }`.trim()}
      aria-label={t('card.playAria', { card: description })}
      aria-disabled={!playable}
      disabled={!playable}
      title={playable ? description : (disabledReason ?? description)}
      onClick={() => {
        onPlay(card);
      }}
    >
      <CardBody card={card} t={t} />
    </button>
  );
}

export interface FaceDownCardProps {
  readonly t: Translator;
  readonly size?: CardSize;
}

export function FaceDownCard({ t, size = 'md' }: FaceDownCardProps): ReactNode {
  return (
    <div className={`card card--back ${SIZE_CLASS[size]}`.trim()} role="img" aria-label={t('card.faceDown')}>
      <span className="card__glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="12" cy="12" r="2.4" fill="currentColor" />
        </svg>
      </span>
    </div>
  );
}
