import {
  memo,
  useEffect,
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
import { animate, cancelAnimations } from '../../../../lib/motion.ts';
import {
  geometryStale,
  handDeltas,
  isSettled,
  sameCards,
  type SlotGeometry,
  type SlotMap,
} from '../handFlip.ts';
import type { AnchorRegistry } from '../anchors.ts';
import { depthBucket } from '../pileDepth.ts';
import { sweepStyle } from '../sweepDirection.ts';
import { CardFace, FaceDownCard, PlayableCard } from './CardView.tsx';

/** Where the blocked-pile reason lives, for `aria-describedby`. */
const DRAW_BLOCKED_ID = 'draw-pile-blocked-reason';

/** Per-card delay in the arming wave. Twenty-five milliseconds reads as one gesture. */
const ARM_STAGGER_MS = 25;

/** How long a card takes to travel to its new slot when the hand reflows. */
const HAND_FLIP_MS = 220;

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
  onCatch,
  registry,
}: {
  readonly opponent: OpponentView;
  readonly t: Translator;
  readonly onCatch?: (playerId: string) => void;
  readonly registry?: AnchorRegistry | undefined;
}): ReactNode {
  const lastCard = opponent.cardCount === 1;
  return (
    <li
      className={`seat ${opponent.isCurrent ? 'seat--current' : ''}`.trim()}
      ref={(node) => {
        registry?.set(`seat:${opponent.id}`, node);
      }}
    >
      <span className="seat__pile">
        <FaceDownCard t={t} size="xs" />
      </span>
      <span className="seat__name truncate" title={opponent.name}>
        {opponent.name}
      </span>
      <span className={`seat__count ${lastCard ? 'seat__count--low' : ''}`.trim()}>
        {countLabel(t, 'game.cardsLeft', opponent.cardCount)}
      </span>
      {/*
       * The declaration is the difference between a seat that is safe on one card
       * and a seat that can be called out for it. Calling it out is the other
       * player's job, so it is a button, and it lives here — on the seat the claim
       * is about — rather than in a prompt somewhere else on the screen.
       */}
      {opponent.declaredLastCard ? (
        <span className="seat__declared">
          <Icon name="check" size={0.85} />
          {t('game.declaredLastCard')}
        </span>
      ) : opponent.catchable && onCatch ? (
        <button
          type="button"
          className="seat__catch"
          onClick={() => {
            onCatch(opponent.id);
          }}
          aria-label={t('game.catchLastCard', { name: opponent.name })}
        >
          {t('game.catchLastCardShort')}
        </button>
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
  onCatch,
  sweep,
  registry,
}: {
  readonly opponents: readonly OpponentView[];
  readonly t: Translator;
  readonly onCatch?: (playerId: string) => void;
  readonly sweep?: { readonly key: string; readonly direction: 1 | -1 } | undefined;
  readonly registry?: AnchorRegistry | undefined;
}): ReactNode {
  return (
    <section className="seats" aria-label={t('game.opponents')}>
      <ul className="seats__list">
        {/*
         * The direction change borrows this row, because it is the only state in
         * the game with nowhere of its own to be shown. Keyed so a new sweep
         * replaces the last one rather than queueing behind it.
         */}
        {sweep ? (
          <span
            key={sweep.key}
            className="seats__sweep"
            aria-hidden="true"
            style={sweepStyle(sweep.direction)}
          />
        ) : null}
        {opponents.map((opponent) => (
          <OpponentSeat
            key={opponent.id}
            opponent={opponent}
            t={t}
            {...(onCatch ? { onCatch } : {})}
            registry={registry}
          />
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
  /** True when the newest beat actually put a card here. */
  readonly landed: boolean;
  /** Where flights start and end. */
  readonly registry?: AnchorRegistry | undefined;
  readonly canDraw: boolean;
  readonly onDraw: () => void;
  /** Called when the pile is pressed while it cannot be used. */
  readonly onDrawBlocked: () => void;
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
  landed,
  registry,
  canDraw,
  onDraw,
  onDrawBlocked,
  drawBlockedReason,
}: PilesProps): ReactNode {
  return (
    <div className="piles">
      <div className="pile">
        {/* The wrapper replaces the button as a child of `.pile` rather than
            sitting beside it: a fourth child would add a flex gap, and the pile
            card's size is solved from the height left over after a hand-measured
            chrome constant. */}
        <div
          className="pile__deck"
          data-depth={depthBucket(drawPileCount)}
          ref={(node) => {
            registry?.set('pile:draw', node);
          }}
        >
          {/*
           * `aria-disabled` rather than `disabled`, the same trade `PlayableCard`
           * made and for the same reasons: a disabled button gets no press
           * feedback, sits outside the tab order, and hides its `title` from most
           * browsers — so the one thing a blocked pile had to say was unreachable
           * and a tap on it was silence. An illegal *card* has always explained
           * itself; the pile now does too.
           *
           * The cost is real and worth naming: while the pile is blocked, which is
           * most of a game, it is a tab stop.
           */}
          <button
            type="button"
            className={`card card--back card--lg ${canDraw ? 'card--playable' : 'card--dimmed'}`}
            onClick={canDraw ? onDraw : onDrawBlocked}
            aria-disabled={!canDraw}
            aria-label={countLabel(t, 'game.drawPileAria', drawPileCount)}
            aria-describedby={canDraw ? undefined : DRAW_BLOCKED_ID}
          />
          {/* The reason, where a screen reader can reach it. It used to live only
              in a `title` on a disabled element, which is nowhere. */}
          {canDraw ? null : (
            <span id={DRAW_BLOCKED_ID} className="sr-only">
              {drawBlockedReason}
            </span>
          )}
        </div>
        <span className="pile__label">{t('game.drawPile')}</span>
        <span className="pile__count">{countLabel(t, 'game.cardsLeft', drawPileCount)}</span>
      </div>

      <div className="pile pile--discard">
        <div
          className={`discard discard--${activeColor}`}
          ref={(node) => {
            registry?.set('pile:discard', node);
          }}
        >
          {discardTop ? (
            /*
             * `card--landing` only when a card was actually played.
             *
             * The class used to ride on a `key` of the card's id, which replays
             * the animation on any remount — so a reconnecting client watched a
             * card land that nobody had played, and so did anyone whose tab came
             * back from the background.
             */
            <CardFace
              key={discardTop.id}
              card={discardTop}
              t={t}
              size="lg"
              extraClass={landed ? 'card--landing' : ''}
            />
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
  readonly registry?: AnchorRegistry | undefined;
}

/**
 * Animates the hand from where it was to where it now is.
 *
 * Not driven by the beat, and that is the whole design. On a client the hand
 * changes when the private hand arrives and the beat is published one write later,
 * with the events — so rects captured "when the beat lands" have already moved and
 * every delta would be zero. Instead the last known geometry is remembered and
 * compared against the current geometry whenever the set of cards changes.
 *
 * The slots are animated, never the cards. A slot is a bare list item; a card
 * carries a layered shadow and five extruded symbol groups, and transforming one
 * promotes all of that to its own composited layer. `will-change` is dropped when
 * the animation ends for the same reason — fourteen permanently promoted layers is
 * how a phone loses its frame budget.
 */
function useHandFlip(
  listRef: RefObject<HTMLUListElement | null>,
  cards: readonly Card[],
  solvedCount: number,
): void {
  const previous = useRef<SlotMap>(new Map());
  const previousFrame = useRef<{ readonly box: DOMRectReadOnly; readonly direction: string } | null>(null);
  const running = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }

    /*
     * Only ever measure a settled hand.
     *
     * A count change produces a commit whose cards are new and whose track width
     * is still the old one. Measuring it recorded halfway positions as though they
     * were where the player last saw the cards, so the next move animated from a
     * wrong baseline — and the error compounded until cards were flying in from
     * off the screen, which is exactly what the layout test caught.
     */
    if (solvedCount !== cards.length) {
      return;
    }

    const slots = new Map<string, SlotGeometry>();
    for (const slot of list.querySelectorAll<HTMLElement>('.hand__slot')) {
      const cardId = slot.dataset['cardId'];
      if (cardId === undefined) {
        continue;
      }
      const rect = slot.getBoundingClientRect();
      const card = slot.querySelector('.card')?.getBoundingClientRect();
      slots.set(cardId, { left: rect.left, top: rect.top, cardWidth: card?.width ?? 0 });
    }

    /*
     * An unsettled measurement is not recorded either, so the next settled one is
     * still compared against the last position the player actually saw.
     */
    if (!isSettled(slots)) {
      return;
    }

    const before = previous.current;
    const frame = {
      box: list.getBoundingClientRect(),
      direction: typeof document === 'undefined' ? 'ltr' : document.documentElement.dir,
    };
    const stale = geometryStale(previousFrame.current, frame);
    previous.current = slots;
    previousFrame.current = frame;
    // Nothing arrived or left: this is the solver's second commit, not a move.
    if (before.size === 0 || sameCards(before, slots)) {
      return;
    }
    /*
     * Nothing remembered is comparable any more, so record and animate nothing.
     * Either the hand moved as a whole — a viewport can change height without
     * changing anything the solver solves for — or the writing direction changed,
     * which mirrors the row and moves the outermost card by more than half the
     * screen.
     */
    if (stale) {
      return;
    }

    /*
     * Let go of the promoted layers *before* cancelling.
     *
     * `cancelAnimations` detaches `oncancel` so that nothing observes the abort,
     * which means the release handler below never runs for an animation that is
     * cancelled — and a slot that is not replaced by a new animation would keep
     * `will-change` set for the life of the hand. Fourteen permanently promoted
     * layers is exactly what that flag is dangerous for.
     */
    for (const slot of list.querySelectorAll<HTMLElement>('.hand__slot')) {
      slot.style.willChange = '';
    }
    cancelAnimations(running.current);
    running.current = [];

    for (const delta of handDeltas(before, slots)) {
      const slot = list.querySelector<HTMLElement>(`[data-card-id="${delta.cardId}"]`);
      if (!slot) {
        continue;
      }
      slot.style.willChange = 'transform';
      const animation = animate(
        slot,
        [
          {
            transform: `translate(${String(delta.dx)}px, ${String(delta.dy)}px) scale(${String(delta.scale)})`,
          },
          { transform: 'none' },
        ],
        { duration: HAND_FLIP_MS, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' },
      );
      const release = (): void => {
        slot.style.willChange = '';
      };
      if (animation) {
        animation.onfinish = release;
        animation.oncancel = release;
        running.current.push(animation);
      } else {
        // No platform animation: the DOM is already correct, which is the point.
        release();
      }
    }
    // The card identities are what a move changes; their order is derived from it.
  }, [listRef, cards, solvedCount]);

  useEffect(
    () => () => {
      cancelAnimations(running.current);
      running.current = [];
    },
    [],
  );
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
  /**
   * The card count `layout` was solved for.
   *
   * Reported because a layout takes two commits to settle: the scale is computed
   * inline from the count and lands one render before the solver's track width
   * does. Anything that measures the hand has to know whether what it is looking
   * at is the finished arrangement or the halfway one — and the count is the only
   * signal that works, because when the solved tracks happen to be unchanged the
   * solver reuses the previous object and there is no second commit to notice.
   */
  readonly solvedCount: number;
  readonly areaRef: RefObject<HTMLElement | null>;
  readonly listRef: RefObject<HTMLUListElement | null>;
} {
  const areaRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [solved, setSolved] = useState<{ readonly layout: HandLayout; readonly count: number }>({
    layout: UNMEASURED,
    count: -1,
  });

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area || typeof ResizeObserver === 'undefined') {
      return;
    }
    const measure = (): void => {
      const first = listRef.current?.querySelector<HTMLElement>('.card');
      const card = first?.getBoundingClientRect().width ?? 0;
      const next = solveHandLayout(area.clientWidth - EDGE_MARGIN_PX * 2, card, count);
      setSolved((previous) =>
        previous.count === count &&
        previous.layout.perRow === next.perRow &&
        previous.layout.strip === next.strip &&
        previous.layout.card === next.card
          ? previous
          : { layout: next, count },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => {
      observer.disconnect();
    };
  }, [count]);

  return { layout: solved.layout, solvedCount: solved.count, areaRef, listRef };
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
  registry,
}: HandProps): ReactNode {
  const playable = new Set(playableIds);
  const { layout, solvedCount, areaRef, listRef } = useHandLayout(cards.length);

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

  /*
   * "I have something I can play." Not "it is my turn": an open +3 makes a
   * breaker legal from any seat, out of turn, and that is the most time-critical
   * decision in the game — precisely the moment the cue is worth most.
   */
  const armed = playable.size > 0;
  useHandFlip(listRef, cards, solvedCount);

  return (
    <section
      className="hand-area"
      aria-label={t('game.yourHand')}
      ref={(node) => {
        areaRef.current = node;
        // Everything that happens to me anchors here: the seat list holds only
        // opponents, so `seat:<me>` never resolves.
        registry?.set('hand', node);
      }}
    >
      <div className="hand-area__head">
        <h2 className="hand-area__title">{t('game.yourHand')}</h2>
        <span className="hand-area__count">{countLabel(t, 'game.handCount', cards.length)}</span>
      </div>
      <ul
        className={`hand ${armed ? 'hand--armed' : ''}`.trim()}
        style={style}
        ref={listRef}
        onKeyDown={onKeyDown}
      >
        {cards.map((card, index) => (
          <li
            key={card.id}
            className="hand__slot"
            // The FLIP finds a slot by the card it holds, not by its position.
            data-card-id={card.id}
            ref={(node) => {
              registry?.set(`slot:${card.id}`, node);
            }}
            /*
             * The wave runs across the hand rather than arriving all at once.
             * Ordered by position, not by which cards happen to be playable, so
             * the sweep reads as one gesture over the hand.
             */
            style={{ '--lift-delay': `${index * ARM_STAGGER_MS}ms` } as CSSProperties}
          >
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
