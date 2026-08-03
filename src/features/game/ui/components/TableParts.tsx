import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Icon } from '../../../../components/Icon.tsx';
import { countLabel, type Translator } from '../../../../i18n/index.ts';
import type { Card, CardColor } from '../../engine/cards.ts';
import type { ConnectionHealth } from '../../network/protocol.ts';
import type { OpponentView } from '../../state/selectors.ts';
import { colorName } from '../cardText.ts';
import {
  EDGE_MARGIN_PX,
  UNMEASURED,
  handCardScale,
  solveHandLayout,
  type HandLayout,
} from '../handLayout.ts';
import { CardFace, FaceDownCard, PlayableCard } from './CardView.tsx';

/**
 * The colour that must currently be matched.
 *
 * A swatch plus its name, never the swatch alone: the whole point of the
 * indicator is lost on a player who cannot separate red from green.
 */
export function ColorIndicator({
  color,
  t,
}: {
  readonly color: CardColor;
  readonly t: Translator;
}): ReactNode {
  return (
    <span className={`color-swatch color-swatch--${color}`}>
      <span className="color-swatch__dot" aria-hidden="true" />
      {t('game.activeColor', { color: colorName(t, color) })}
    </span>
  );
}

/** Which way round the table play is moving. */
export function DirectionIndicator({
  direction,
  t,
}: {
  readonly direction: 1 | -1;
  readonly t: Translator;
}): ReactNode {
  const label = direction === 1 ? t('game.directionCw') : t('game.directionCcw');
  return (
    <span className="direction-chip">
      <Icon name={direction === 1 ? 'clockwise' : 'anticlockwise'} size={1.15} />
      <span className="direction-chip__label">{label}</span>
    </span>
  );
}

/**
 * A player's link quality.
 *
 * A healthy connection is the normal case and says so with a dot alone; anything
 * worse spells the word out, because that is the state a player has to act on.
 */
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
      {health === 'connected' ? <span className="sr-only">{labels[health]}</span> : labels[health]}
    </span>
  );
}

const OpponentSeat = memo(function OpponentSeat({
  opponent,
  t,
}: {
  readonly opponent: OpponentView;
  readonly t: Translator;
}): ReactNode {
  const lastCard = opponent.cardCount === 1;
  return (
    <li className={`seat ${opponent.isCurrent ? 'seat--current' : ''}`.trim()}>
      <span className="seat__pile">
        <FaceDownCard t={t} size="xs" />
      </span>
      <span className="seat__name truncate" title={opponent.name}>
        {opponent.name}
      </span>
      <span className={`seat__count ${lastCard ? 'seat__count--low' : ''}`.trim()}>
        {countLabel(t, 'game.cardsLeft', opponent.cardCount)}
      </span>
      {/* Who has declared is the difference between a player one card from the
          win and a player one card from a two-card penalty. */}
      {opponent.declaredLastCard ? (
        <span className="seat__declared">
          <Icon name="check" size={0.85} />
          {t('game.declaredLastCard')}
        </span>
      ) : lastCard ? (
        <span className="sr-only">{t('game.lastCard')}</span>
      ) : null}
      <HealthBadge health={opponent.health} t={t} />
      {opponent.isCurrent ? (
        <>
          <span className="seat__marker" aria-hidden="true" />
          <span className="sr-only">{t('game.turnBadge')}</span>
        </>
      ) : null}
    </li>
  );
});

/**
 * The other players, in play order starting after the local seat, so what is on
 * screen matches the order of play whoever is looking.
 *
 * Laid out as a row of narrow seats rather than wide cards, so a full table of
 * six fits across a phone without a horizontal scroll — whose turn it is must
 * never be something a player has to scroll to find.
 */
export function OpponentList({
  opponents,
  t,
}: {
  readonly opponents: readonly OpponentView[];
  readonly t: Translator;
}): ReactNode {
  return (
    <section className="seats" aria-label={t('game.opponents')}>
      <ul className="seats__list">
        {opponents.map((opponent) => (
          <OpponentSeat key={opponent.id} opponent={opponent} t={t} />
        ))}
      </ul>
    </section>
  );
}

export interface PilesProps {
  readonly t: Translator;
  readonly discardTop: Card | null;
  readonly drawPileCount: number;
  readonly activeColor: CardColor;
  readonly canDraw: boolean;
  readonly onDraw: () => void;
  readonly drawBlockedReason: string;
}

/**
 * The middle of the table: the pile you draw from, the card you must match, and
 * the colour that is currently in force.
 *
 * The active colour is drawn as a rail *around the discard pile* rather than as a
 * chip elsewhere on the screen. After a Change Colour the top card and the
 * colour in force disagree, and that is exactly the moment a player needs the
 * two facts in one place.
 */
export function Piles({
  t,
  discardTop,
  drawPileCount,
  activeColor,
  canDraw,
  onDraw,
  drawBlockedReason,
}: PilesProps): ReactNode {
  return (
    <div className="piles">
      <div className="pile">
        <button
          type="button"
          className={`card card--back card--lg ${canDraw ? 'card--playable' : 'card--dimmed'}`}
          onClick={onDraw}
          disabled={!canDraw}
          aria-label={countLabel(t, 'game.drawPileAria', drawPileCount)}
          title={canDraw ? t('game.drawPile') : drawBlockedReason}
        />
        <span className="pile__label">{t('game.drawPile')}</span>
        <span className="pile__count">{countLabel(t, 'game.cardsLeft', drawPileCount)}</span>
      </div>

      <div className="pile pile--discard">
        <div className={`discard discard--${activeColor}`}>
          {discardTop ? (
            <CardFace key={discardTop.id} card={discardTop} t={t} size="lg" extraClass="card--landing" />
          ) : (
            <p className="discard__empty text-small">{t('game.discardEmpty')}</p>
          )}
        </div>
        <span className="pile__label">{t('game.discardTop')}</span>
        <ColorIndicator color={activeColor} t={t} />
      </div>
    </div>
  );
}

export interface HandProps {
  readonly cards: readonly Card[];
  readonly playableIds: readonly string[];
  readonly t: Translator;
  readonly onPlay: (card: Card) => void;
  readonly onRefuse?: (card: Card) => void;
  readonly disabledReason: string;
  readonly locked?: boolean;
}

/**
 * Measures the hand and keeps the solved layout in state.
 *
 * The width comes from the area around the row, never from the row itself: the
 * row's own width is a function of the layout being solved, and measuring it
 * would feed back into the next measurement.
 */
function useHandLayout(count: number): {
  readonly layout: HandLayout;
  readonly areaRef: RefObject<HTMLElement | null>;
  readonly listRef: RefObject<HTMLUListElement | null>;
} {
  const areaRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [layout, setLayout] = useState<HandLayout>(UNMEASURED);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area || typeof ResizeObserver === 'undefined') {
      return;
    }
    const measure = (): void => {
      const first = listRef.current?.querySelector<HTMLElement>('.card');
      const card = first?.getBoundingClientRect().width ?? 0;
      const next = solveHandLayout(area.clientWidth - EDGE_MARGIN_PX * 2, card, count);
      setLayout((previous) =>
        previous.perRow === next.perRow && previous.strip === next.strip && previous.card === next.card
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => {
      observer.disconnect();
    };
  }, [count]);

  return { layout, areaRef, listRef };
}

/**
 * The player's own cards.
 *
 * Every card in the hand is on screen: the row overlaps as it fills up and then
 * wraps onto a second row, so nothing is ever hidden behind a swipe. A card never
 * gives up more than half of itself, the focused or hovered card lifts clear of
 * its neighbours, and the whole hand is one keyboard widget — a single tab stop,
 * arrows along the row and across rows, Home and End to the ends. Fourteen cards
 * would otherwise be fourteen tab stops between the table and everything below.
 */
export function Hand({
  cards,
  playableIds,
  t,
  onPlay,
  onRefuse,
  disabledReason,
  locked = false,
}: HandProps): ReactNode {
  const playable = new Set(playableIds);
  const { layout, areaRef, listRef } = useHandLayout(cards.length);

  /** The roving tab stop starts on the first legal card, or on the first card. */
  const firstPlayable = cards.findIndex((card) => playable.has(card.id));
  const activeIndex = firstPlayable < 0 ? 0 : firstPlayable;

  const focusCard = (index: number): void => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button.card');
    if (!buttons || buttons.length === 0) {
      return;
    }
    const target = buttons[Math.max(0, Math.min(index, buttons.length - 1))];
    target?.focus();
    // Not implemented in every environment the tests run in.
    target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button.card') ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) {
      return;
    }
    const rtl = document.documentElement.dir === 'rtl';
    const forwards = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backwards = rtl ? 'ArrowRight' : 'ArrowLeft';
    // A row's worth of cards, so Up and Down land on the card directly above or
    // below rather than walking the whole hand.
    const stride = Math.max(1, layout.perRow || buttons.length);

    switch (event.key) {
      case forwards:
        event.preventDefault();
        focusCard(current + 1);
        return;
      case backwards:
        event.preventDefault();
        focusCard(current - 1);
        return;
      case 'ArrowDown':
        event.preventDefault();
        focusCard(current + stride);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusCard(current - stride);
        return;
      case 'Home':
        event.preventDefault();
        focusCard(0);
        return;
      case 'End':
        event.preventDefault();
        focusCard(buttons.length - 1);
        return;
      default:
        return;
    }
  };

  /*
   * Handed to the stylesheet rather than applied here: the row is laid out as a
   * grid of `--hand-strip` tracks holding cards a full `--hand-card` wide, so
   * each card laps over the one before it by exactly the solved amount, and the
   * last card of every row overhangs into the row's trailing padding.
   */
  const style = {
    // Set first, and independently of any measurement: the measured card width
    // below is the *scaled* one, which is what the layout has to be solved from.
    '--hand-scale': handCardScale(cards.length),
    ...(layout.perRow > 0
      ? {
          '--hand-per-row': layout.perRow,
          '--hand-strip': `${layout.strip}px`,
          '--hand-card': `${layout.card}px`,
        }
      : {}),
  } as CSSProperties;

  return (
    <section className="hand-area" aria-label={t('game.yourHand')} ref={areaRef}>
      <div className="hand-area__head">
        <h2 className="hand-area__title">{t('game.yourHand')}</h2>
        <span className="hand-area__count">{countLabel(t, 'game.handCount', cards.length)}</span>
      </div>
      <ul className="hand" style={style} ref={listRef} onKeyDown={onKeyDown}>
        {cards.map((card, index) => (
          <li key={card.id} className="hand__slot">
            <PlayableCard
              card={card}
              t={t}
              playable={playable.has(card.id)}
              onPlay={onPlay}
              {...(onRefuse ? { onRefuse } : {})}
              disabledReason={disabledReason}
              locked={locked}
              tabIndex={index === activeIndex ? 0 : -1}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
