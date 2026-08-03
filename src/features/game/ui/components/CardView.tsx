import { memo, type ReactNode } from 'react';
import type { Translator } from '../../../../i18n/index.ts';
import { cardColor, type Card } from '../../engine/cards.ts';
import { describeCard } from '../cardText.ts';
import { CardGlyph } from './CardGlyph.tsx';

export type CardSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASS: Record<CardSize, string> = {
  xs: 'card--xs',
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

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;

/**
 * The printed face: the symbol large in the middle and small in all four
 * corners, the bottom pair upside down, so the card reads either way up and a
 * fanned hand stays legible. No word is printed on a real card, and none is
 * needed here — every symbol is a distinct shape, and the full name is on the
 * card's accessible label.
 *
 * Memoised on the card's identity because it is the most expensive thing the app
 * draws: each face builds five extruded symbols out of polygon geometry, and a
 * hand of twelve cards is sixty of them. Before this, every unrelated store
 * change — a heartbeat re-grading a connection, a toast appearing — rebuilt the
 * lot.
 */
const CardBody = memo(function CardBody({ card }: { readonly card: Card }): ReactNode {
  return (
    <>
      {CORNERS.map((corner) => (
        <span key={corner} className={`card__corner card__corner--${corner}`} aria-hidden="true">
          <CardGlyph card={card} flat />
        </span>
      ))}
      <span className="card__glyph">
        <CardGlyph card={card} />
      </span>
    </>
  );
});

export interface CardFaceProps {
  readonly card: Card;
  readonly t: Translator;
  readonly size?: CardSize;
  readonly extraClass?: string;
}

/** Non-interactive card face, e.g. the top of the discard pile. */
export const CardFace = memo(function CardFace({
  card,
  t,
  size = 'md',
  extraClass,
}: CardFaceProps): ReactNode {
  return (
    <div
      className={`card ${colorClass(card)} ${SIZE_CLASS[size]} ${extraClass ?? ''}`.trim()}
      {...kindAttrs(card)}
      role="img"
      aria-label={describeCard(t, card)}
    >
      <CardBody card={card} />
    </div>
  );
});

export interface PlayableCardProps {
  readonly card: Card;
  readonly t: Translator;
  readonly playable: boolean;
  readonly onPlay: (card: Card) => void;
  /** Called when a card that cannot be played is pressed anyway. */
  readonly onRefuse?: (card: Card) => void;
  readonly size?: CardSize;
  /** Explains why the card cannot be played, for assistive technology. */
  readonly disabledReason?: string;
  /** Roving tab stop: exactly one card in the hand is reachable by Tab. */
  readonly tabIndex?: number;
  /** True while a submitted move is still unanswered. */
  readonly locked?: boolean;
}

/**
 * A card in the local player's hand.
 *
 * Deliberately `aria-disabled` rather than `disabled`. A disabled button cannot
 * be focused, which would make an illegal card unreachable: a player using a
 * keyboard or a screen reader could not read their own hand, and a player using
 * a finger would tap it and get silence. This way every card can be inspected,
 * activation is blocked in one place, and pressing an illegal card explains
 * itself instead of doing nothing.
 */
export const PlayableCard = memo(function PlayableCard({
  card,
  t,
  playable,
  onPlay,
  onRefuse,
  size = 'md',
  disabledReason,
  tabIndex = 0,
  locked = false,
}: PlayableCardProps): ReactNode {
  const description = describeCard(t, card);
  const blocked = !playable || locked;
  return (
    <button
      type="button"
      className={`card ${colorClass(card)} ${SIZE_CLASS[size]} ${
        playable ? 'card--playable' : 'card--dimmed'
      }`.trim()}
      {...kindAttrs(card)}
      aria-label={t('card.playAria', { card: description })}
      aria-disabled={blocked}
      title={playable ? description : (disabledReason ?? description)}
      tabIndex={tabIndex}
      onClick={() => {
        if (blocked) {
          onRefuse?.(card);
          return;
        }
        onPlay(card);
      }}
    >
      <CardBody card={card} />
    </button>
  );
});

export interface FaceDownCardProps {
  readonly t: Translator;
  readonly size?: CardSize;
  readonly extraClass?: string;
}

/**
 * A card seen from behind. The back is all pattern, as a printed one is: the
 * weave is drawn by the stylesheet, so there is nothing to render inside.
 */
export function FaceDownCard({ t, size = 'md', extraClass }: FaceDownCardProps): ReactNode {
  return (
    <div
      className={`card card--back ${SIZE_CLASS[size]} ${extraClass ?? ''}`.trim()}
      role="img"
      aria-label={t('card.faceDown')}
    />
  );
}
