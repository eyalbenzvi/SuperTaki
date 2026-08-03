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

/** Lets the stylesheet give an individual card kind its own colour, e.g. a gold King. */
function kindAttrs(card: Card): { readonly 'data-kind': string } {
  return { 'data-kind': card.kind };
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
      {...kindAttrs(card)}
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
      {/* The same symbol in two opposite corners, as on a printed card, so a
          fanned hand stays readable. The second one is upside down. */}
      <span className="card__corner card__corner--start" aria-hidden="true">
        <CardGlyph card={card} />
      </span>
      <span className="card__glyph">
        <CardGlyph card={card} />
      </span>
      {/* Action cards need a word as well as a symbol: colour and shape alone
          would not separate +2 from +3 at a glance. A number card's glyph is
          already the value, so repeating it would only add clutter. */}
      {isNumberCard(card) ? null : (
        <span className="card__label" aria-hidden="true">
          {cardFaceLabel(t, card)}
        </span>
      )}
      <span className="card__corner card__corner--end" aria-hidden="true">
        <CardGlyph card={card} />
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
      {...kindAttrs(card)}
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

/**
 * A card seen from behind. The back is all pattern, as a printed one is: the
 * weave is drawn by the stylesheet, so there is nothing to render inside.
 */
export function FaceDownCard({ t, size = 'md' }: FaceDownCardProps): ReactNode {
  return (
    <div
      className={`card card--back ${SIZE_CLASS[size]}`.trim()}
      role="img"
      aria-label={t('card.faceDown')}
    />
  );
}
