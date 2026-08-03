import type { ReactNode } from 'react';
import type { Translator } from '../../../../i18n/index.ts';
import type { Card, CardColor } from '../../engine/cards.ts';
import type { ConnectionHealth } from '../../network/protocol.ts';
import type { OpponentView } from '../../state/selectors.ts';
import { colorName } from '../cardText.ts';
import { CardFace, FaceDownCard, PlayableCard } from './CardView.tsx';

/** Coloured indicator for the colour that must currently be matched. */
export function ColorIndicator({
  color,
  t,
}: {
  readonly color: CardColor;
  readonly t: Translator;
}): ReactNode {
  return (
    <span className="color-swatch">
      <span className={`color-swatch__dot color-dot--${color}`} aria-hidden="true" />
      {t('game.activeColor', { color: colorName(t, color) })}
    </span>
  );
}

export function HealthBadge({
  health,
  t,
}: {
  readonly health: ConnectionHealth;
  readonly t: Translator;
}): ReactNode {
  const labels = {
    connected: t('health.connected'),
    unstable: t('health.unstable'),
    disconnected: t('health.disconnected'),
  } as const;
  return (
    <span className={`health health--${health}`}>
      <span className="health__dot" aria-hidden="true" />
      {labels[health]}
    </span>
  );
}

export function OpponentList({
  opponents,
  t,
}: {
  readonly opponents: readonly OpponentView[];
  readonly t: Translator;
}): ReactNode {
  return (
    <section aria-label={t('game.opponents')}>
      <ul className="opponents">
        {opponents.map((opponent) => (
          <li
            key={opponent.id}
            className={`opponent ${opponent.isCurrent ? 'opponent--current' : ''}`.trim()}
          >
            <FaceDownCard t={t} size="sm" />
            <div className="opponent__info">
              <span className="opponent__name">{opponent.name}</span>
              <span className="opponent__cards">{t('game.cardsLeft', { count: opponent.cardCount })}</span>
              <HealthBadge health={opponent.health} t={t} />
              {opponent.isCurrent ? <span className="badge badge--turn">{t('game.yourTurn')}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface PilesProps {
  readonly t: Translator;
  readonly discardTop: Card | null;
  readonly drawPileCount: number;
  readonly canDraw: boolean;
  readonly onDraw: () => void;
  readonly drawBlockedReason: string;
}

export function Piles({
  t,
  discardTop,
  drawPileCount,
  canDraw,
  onDraw,
  drawBlockedReason,
}: PilesProps): ReactNode {
  return (
    <div className="piles">
      <div className="pile">
        <span className="pile__label" id="draw-pile-label">
          {t('game.drawPile')}
        </span>
        <button
          type="button"
          className={`card card--back card--lg ${canDraw ? 'card--playable' : 'card--dimmed'}`}
          onClick={onDraw}
          disabled={!canDraw}
          aria-disabled={!canDraw}
          aria-label={t('game.drawPileAria', { count: drawPileCount })}
          title={canDraw ? t('game.drawPile') : drawBlockedReason}
        />
        <span className="pile__count">{t('game.cardsLeft', { count: drawPileCount })}</span>
      </div>

      <div className="pile">
        <span className="pile__label">{t('game.discardTop')}</span>
        {discardTop ? (
          <CardFace card={discardTop} t={t} size="xl" />
        ) : (
          <p className="text-small muted">{t('game.discardEmpty')}</p>
        )}
      </div>
    </div>
  );
}

export interface HandProps {
  readonly cards: readonly Card[];
  readonly playableIds: readonly string[];
  readonly t: Translator;
  readonly onPlay: (card: Card) => void;
  readonly disabledReason: string;
}

export function Hand({ cards, playableIds, t, onPlay, disabledReason }: HandProps): ReactNode {
  const playable = new Set(playableIds);
  return (
    <section aria-label={t('game.yourHand')}>
      <div className="row row--between">
        <h2 className="panel__title">{t('game.yourHand')}</h2>
        <span className="text-small muted">{t('game.handCount', { count: cards.length })}</span>
      </div>
      <ul className="hand">
        {cards.map((card) => (
          <li key={card.id} className="hand__slot">
            <PlayableCard
              card={card}
              t={t}
              playable={playable.has(card.id)}
              onPlay={onPlay}
              disabledReason={disabledReason}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
