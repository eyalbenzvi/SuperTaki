import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '../../../../components/Button.tsx';
import { Callout } from '../../../../components/Callout.tsx';
import { Icon } from '../../../../components/Icon.tsx';
import { useDirection, useT } from '../../../../app/useT.ts';
import { countLabel, type Translator } from '../../../../i18n/index.ts';
import { LAST_CARD_PENALTY, requiresColorChoice, type Card, type CardColor } from '../../engine/cards.ts';
import {
  canBreakPlusThree,
  currentPlayerName,
  hasDeclaredLastCard,
  isMyTurn,
  isTakiOpenForMe,
  mustDeclareLastCard,
  myStairsStep,
  opponents,
  playableCardIds,
  playerName,
  sortHandForDisplay,
  type TableSnapshot,
} from '../../state/selectors.ts';
import { useAppStore, type FeedEntry } from '../../state/store.ts';
import { colorName } from '../cardText.ts';
import { describeEvent } from '../eventText.ts';
import { useCatchGrace } from '../useCatchGrace.ts';
import { playCue } from '../../../../lib/audio.ts';
import { penaltyBuzz, returnBuzz } from '../../../../lib/haptics.ts';
import { AnchorRegistry } from '../anchors.ts';
import { cueFor } from '../choreograph.ts';
import { ColorPickerModal } from '../components/ColorPickerModal.tsx';
import { FlightLayer } from '../components/FlightLayer.tsx';
import { ConnectionPhaseNotice } from '../components/ConnectionPhaseNotice.tsx';
import { CaughtNotice, NudgeButton, NudgeNotice } from '../components/TableControls.tsx';
import { WaitingNotice } from '../components/WaitingNotice.tsx';
import { GameLog } from '../components/GameLog.tsx';
import { DirectionIndicator, Hand, OpponentList, Piles } from '../components/TableParts.tsx';

/** How long a "you cannot play that" explanation stays on screen. */
const REFUSAL_MS = 2600;

type TableView = TableSnapshot & {
  readonly feed: readonly FeedEntry[];
  readonly actionPending: boolean;
};

/**
 * The table.
 *
 * Laid out as a fixed-height grid rather than a scrolling document, in the order
 * a player needs things: who else is here, the table itself, what to do now, and
 * the hand pinned under the thumb. Before this the hand sat mid-page with the log
 * and a Leave button below it, so on a phone the primary interaction of the whole
 * product was below the fold.
 */
export function GameScreen(): ReactNode {
  const t = useT();
  /*
   * The play-order arrow points at seats, and the seats are laid out in the
   * document's direction, so the chip needs it. Passed in rather than read from
   * `document` inside the component, which keeps it a pure render of props.
   */
  const textDirection = useDirection();

  /*
   * Subscribed field by field. The table used to re-render on every store change
   * — a heartbeat re-grading a connection, a toast opening, a preference
   * changing — and each render rebuilt the extruded geometry of every symbol on
   * every card in the hand.
   */
  const table = useAppStore(
    useShallow((state): TableView => ({
      publicState: state.publicState,
      localPlayerId: state.localPlayerId,
      hand: state.hand,
      lobby: state.lobby,
      feed: state.feed,
      actionPending: state.actionPending,
    })),
  );
  /*
   * Its own selector, deliberately.
   *
   * Folding `beat` into the shallow object above would change `table`'s identity
   * on every move, which would defeat the `useMemo` on `opponents(table)` below
   * and re-render every seat — the exact cost that memo exists to avoid.
   */
  const beat = useAppStore((state) => state.beat);
  const playCard = useAppStore((state) => state.playCard);
  const drawCard = useAppStore((state) => state.drawCard);
  const closeTaki = useAppStore((state) => state.closeTaki);
  const passBreak = useAppStore((state) => state.passBreak);
  const declareLastCard = useAppStore((state) => state.declareLastCard);
  const catchLastCard = useAppStore((state) => state.catchLastCard);
  const announce = useAppStore((state) => state.announce);

  /*
   * One registry for the table's lifetime. Anchors register themselves as they
   * mount and deregister as they go, so nothing here has to know which of them
   * currently exist — a player's own seat never does, and a card's slot stops
   * existing the moment it is played.
   */
  const [registry] = useState(() => new AnchorRegistry());

  /*
   * The wild card waiting for a colour. Nothing has been played while it sits
   * here: the card is still in hand, the table has not moved, and neither the
   * declaration nor the catch that may follow it exists yet.
   */
  const [pendingWild, setPendingWild] = useState<Card | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { publicState, feed, actionPending } = table;
  const myTurn = isMyTurn(table);
  const playable = playableCardIds(table);
  const takiOpen = isTakiOpenForMe(table);
  const mustDeclare = mustDeclareLastCard(table);
  const declared =
    table.hand.length === 1 &&
    table.localPlayerId !== null &&
    hasDeclaredLastCard(table, table.localPlayerId);
  const cards = useMemo(() => sortHandForDisplay(table.hand), [table.hand]);
  /*
   * The cues this screen draws itself, read off the newest beat.
   *
   * Everything here is derived during render from state the store already holds,
   * so there is no effect, no timer and no ref — which is both simpler and the
   * only shape the compiler's lint rules allow.
   */
  const landed = beat?.events.some((event) => event.type === 'cardPlayed') ?? false;
  const reversal = beat?.events.find((event) => event.type === 'directionChanged');
  const sweep = beat && reversal ? { key: `${beat.seq}`, direction: reversal.direction } : undefined;
  const struck =
    beat?.events.some(
      (event) =>
        (event.type === 'cardDrawn' && event.playerId === table.localPlayerId) ||
        (event.type === 'lastCardCaught' && event.playerId === table.localPlayerId),
    ) ?? false;
  const seats = useCatchGrace(useMemo(() => opponents(table), [table]));
  const turnName = currentPlayerName(table);

  useEffect(
    () => () => {
      if (refusalTimer.current !== null) {
        clearTimeout(refusalTimer.current);
      }
    },
    [],
  );

  /*
   * The table's voice, and a buzz on the two moments worth one.
   *
   * Cues are dropped while the page is hidden — a returning player would otherwise
   * get every sound of the last two minutes at once, which is the commonest bug in
   * browser audio.
   *
   * They are deliberately *not* gated on the live region below. Every beat updates
   * that region, so a "skip the cue when something is being announced" rule would
   * silence the sound feature for everyone — there is no browser signal for whether
   * a screen reader is actually listening. Sound and speech carry different things
   * (that something happened to me, versus what happened) and are meant to coexist;
   * a player who finds them competing turns Sound off in Settings, where it is a
   * first-class, persisted control defaulting on. An earlier version of this comment
   * claimed a ducking behaviour that was never wired, which QA rightly caught.
   */
  const beatSeq = beat?.seq ?? 0;
  useEffect(() => {
    if (!beat || typeof document === 'undefined' || document.visibilityState === 'hidden') {
      return;
    }
    const cue = cueFor(beat, table.localPlayerId);
    if (cue !== null) {
      playCue(cue);
    }
    if (cue === 'penalty') {
      penaltyBuzz();
    } else if (cue === 'yourTurn' && document.visibilityState !== 'visible') {
      returnBuzz();
    }
    // One beat is one accepted command; everything else here is read from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatSeq]);

  /*
   * One announcement per change of state, carrying both halves of the answer to
   * "what just happened, and whose turn is it now". The log list is deliberately
   * not a live region: reading a scrolling history aloud buries this.
   */
  const latestId = feed.length > 0 ? feed[feed.length - 1]?.id : undefined;
  const currentId = publicState?.currentPlayerId ?? null;
  useEffect(() => {
    if (!publicState) {
      return;
    }
    const latest = feed.length > 0 ? feed[feed.length - 1] : undefined;
    const parts = [
      latest ? describeEvent(t, latest.event, (id) => playerName(table, id)) : '',
      myTurn ? t('game.yourTurn') : turnName ? t('game.turnOf', { name: turnName }) : '',
    ].filter(Boolean);
    announce(parts.join(' '));
    // A new event, or a new player on turn, is what makes this worth saying
    // again; re-running it on every render would not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestId, currentId, announce]);

  if (!publicState) {
    return (
      <div className="page">
        <ConnectionPhaseNotice />
        <p role="status">{t('game.waitingForState')}</p>
      </div>
    );
  }

  const onPlay = (card: Card): void => {
    if (requiresColorChoice(card)) {
      setPendingWild(card);
      return;
    }
    playCard(card.id);
  };

  /**
   * A tap on a card that cannot be played says why, rather than doing nothing.
   * Silence reads as a broken control; "wait for your turn" reads as a rule.
   */
  const onRefuse = (): void => {
    const reason = actionPending ? t('game.sending') : myTurn ? t('game.notPlayable') : t('game.notYourTurn');
    setRefusal(reason);
    announce(reason);
    if (refusalTimer.current !== null) {
      clearTimeout(refusalTimer.current);
    }
    refusalTimer.current = setTimeout(() => {
      setRefusal(null);
    }, REFUSAL_MS);
  };

  /*
   * The colour is what sends the card. Until this runs the move has not been made
   * at all, which is what keeps a card that leaves its owner on one from exposing
   * them — or letting them shout — before the table can see anything.
   */
  const onChooseColor = (color: CardColor): void => {
    if (pendingWild) {
      playCard(pendingWild.id, color);
      setPendingWild(null);
    }
  };

  const onBreakPlusThree = (): void => {
    const breaker = table.hand.find((card) => card.kind === 'breakPlusThree');
    if (breaker) {
      playCard(breaker.id);
    }
  };

  const plusThree = publicState.plusThree;
  const plusThreeName = plusThree ? playerName(table, plusThree.playerId) : null;
  // A +3 freezes the table for everyone until the breaker window closes.
  const myBreak = plusThree !== null && canBreakPlusThree(table);
  const canDraw = myTurn && !publicState.takiMode && plusThree === null && !actionPending;

  return (
    <div className="game">
      <div className="game__notice">
        <ConnectionPhaseNotice />
        <NudgeNotice />
        <CaughtNotice />
        <WaitingNotice />
      </div>

      {/*
       * Everything that is not the table or the hand, in one group. Upright the
       * group is transparent — `display: contents` — and its children are rows of
       * the page exactly as before. In landscape it becomes the column beside the
       * table, which is what lets the hand keep the full width and stops a tall
       * stack of notices from pushing it off the bottom of the screen.
       */}
      <div className="game__info">
        <OpponentList opponents={seats} t={t} onCatch={catchLastCard} sweep={sweep} registry={registry} />

        {/*
         * The nudge renders only while the table is genuinely waiting on a
         * connected player, so this row costs nothing the rest of the time. The
         * pause and end-round controls live in the room sheet instead: they are
         * once-an-evening actions, and a permanent row of them above the table
         * pushes a card off the bottom of a 390px screen — which the layout test
         * caught, correctly.
         */}
        <div className="row row--between">
          <NudgeButton />
        </div>

        {/* Outside the scrollable region below: on a short screen, whose turn it is
            is the last thing that should ever scroll out of sight. */}
        <div className="turn-row">
          {/* Keyed on whose turn it is, so the banner re-enters when it changes.
              On my own turn this is the whole cue: there is no seat of mine on
              the table to ring. */}
          <p key={currentId ?? 'none'} className={`turn-banner ${myTurn ? 'turn-banner--mine' : ''}`.trim()}>
            {myTurn ? t('game.yourTurn') : t('game.turnOf', { name: turnName ?? '—' })}
          </p>
          <DirectionIndicator direction={publicState.direction} textDirection={textDirection} t={t} />
        </div>

        <GameLog
          feed={feed}
          t={t}
          describe={(entry) => describeEvent(t, entry.event, (id) => playerName(table, id))}
        />

        <div className="game__action">
          {/*
           * Alongside the prompt, not instead of it.
           *
           * A refusal used to replace the whole prompt for 2.6 seconds. That was
           * survivable while only a card could be refused, but the draw pile now
           * explains itself too — and the commonest reason it is blocked is "not
           * your turn", where the prompt it would have hidden is the only useful
           * thing on the screen.
           */}
          {refusal ? (
            <Callout tone="warning" role="alert">
              {refusal}
            </Callout>
          ) : null}
          {
            <ActionPrompt
              t={t}
              myTurn={myTurn}
              turnName={turnName}
              actionPending={actionPending}
              takiOpen={takiOpen}
              takiColor={publicState.takiMode?.color ?? null}
              plusThreeOpen={plusThree !== null}
              plusThreeName={plusThreeName}
              myBreak={myBreak}
              pendingDraw={publicState.pendingDraw}
              pendingPlus={publicState.pendingPlus}
              freePlay={publicState.freePlay}
              playableCount={playable.length}
              onCloseTaki={closeTaki}
              onTakeCards={drawCard}
              onBreak={onBreakPlusThree}
              onPassBreak={passBreak}
            />
          }
        </div>
      </div>

      <div className="game__table">
        <Piles
          t={t}
          landed={landed}
          registry={registry}
          discardTop={publicState.discardTop}
          drawPileCount={publicState.drawPileCount}
          activeColor={publicState.activeColor}
          canDraw={canDraw}
          onDraw={drawCard}
          onDrawBlocked={onRefuse}
          drawBlockedReason={
            publicState.takiMode ? t('reject.cannotDrawDuringTaki') : t('game.drawPileBlocked')
          }
        />
      </div>

      {/*
       * Its own row, immediately above the hand, rather than one more case in the
       * prompt below. The declaration is legal at any moment and from any seat, so
       * it must not have to wait its turn behind a prompt about somebody else's
       * move — and it is the one control on this screen with a penalty attached to
       * missing it.
       */}
      {mustDeclare || declared ? (
        <div className="game__declare">
          {mustDeclare ? (
            <Button
              variant="primary"
              extraClass="declare-btn"
              block
              onClick={declareLastCard}
              disabled={actionPending}
            >
              <span className="declare-btn__shout">{t('game.declareLastCard')}</span>
              <span className="declare-btn__why">
                {t('game.declareLastCardBody', { count: LAST_CARD_PENALTY })}
              </span>
            </Button>
          ) : (
            <p className="declared-note" role="status">
              <Icon name="check" size={1} />
              {t('game.declaredLastCardMine')}
            </p>
          )}
        </div>
      ) : null}

      <div
        // Keyed so a penalty that lands on me is said once, behind the hand.
        key={struck ? `struck-${beat?.seq ?? 0}` : 'hand'}
        className={`game__hand ${struck ? 'game__hand--struck' : ''}`.trim()}
      >
        <Hand
          cards={cards}
          registry={registry}
          playableIds={playable}
          t={t}
          onPlay={onPlay}
          onRefuse={onRefuse}
          locked={actionPending}
          disabledReason={myTurn ? t('game.notPlayable') : t('game.notYourTurn')}
          stairsStep={myStairsStep(table)}
        />
      </div>

      {/* Last, so it paints over the table it is describing. */}
      <FlightLayer beat={beat} localPlayerId={table.localPlayerId} registry={registry} />

      <ColorPickerModal
        open={pendingWild !== null}
        card={pendingWild}
        t={t}
        onChoose={onChooseColor}
        onCancel={() => {
          setPendingWild(null);
        }}
      />
    </div>
  );
}

interface ActionPromptProps {
  readonly t: Translator;
  readonly myTurn: boolean;
  readonly turnName: string | null;
  readonly actionPending: boolean;
  readonly takiOpen: boolean;
  readonly takiColor: CardColor | null;
  readonly plusThreeOpen: boolean;
  readonly plusThreeName: string | null;
  readonly myBreak: boolean;
  readonly pendingDraw: number;
  readonly pendingPlus: boolean;
  readonly freePlay: boolean;
  readonly playableCount: number;
  readonly onCloseTaki: () => void;
  readonly onTakeCards: () => void;
  readonly onBreak: () => void;
  readonly onPassBreak: () => void;
}

/**
 * The one line that answers "what do I do now", with the buttons for doing it.
 *
 * Exactly one of these is on screen at a time, in strict priority order. The
 * screen used to stack up to four notices at once — a pending draw, a pending
 * Plus, a free play, "no legal card" — each in the same flat blue box, leaving the
 * player to work out which one was actually addressed to them.
 */
function ActionPrompt({
  t,
  myTurn,
  turnName,
  actionPending,
  takiOpen,
  takiColor,
  plusThreeOpen,
  plusThreeName,
  myBreak,
  pendingDraw,
  pendingPlus,
  freePlay,
  playableCount,
  onCloseTaki,
  onTakeCards,
  onBreak,
  onPassBreak,
}: ActionPromptProps): ReactNode {
  // A +3 suspends the turn order for everybody, so it outranks whose turn it is.
  if (plusThreeOpen) {
    return myBreak ? (
      <Callout
        tone="action"
        urgent
        role="status"
        title={t('game.plusThreeTitle')}
        actions={
          <>
            <Button variant="primary" onClick={onBreak}>
              {t('game.plusThreeBreak')}
            </Button>
            <Button variant="ghost" onClick={onPassBreak}>
              {t('game.plusThreePass')}
            </Button>
          </>
        }
      >
        {t('game.plusThreeBreakBody', { name: plusThreeName ?? '—' })}
      </Callout>
    ) : (
      <Callout tone="neutral" icon="hourglass" role="status" title={t('game.plusThreeTitle')}>
        {t('game.plusThreeWaiting', { name: plusThreeName ?? '—' })}
      </Callout>
    );
  }

  if (!myTurn) {
    return (
      <Callout tone="neutral" icon="hourglass" role="status">
        {t('game.waitingFor', { name: turnName ?? '—' })}
      </Callout>
    );
  }

  if (actionPending) {
    return (
      <Callout tone="neutral" icon="hourglass" role="status">
        {t('game.sending')}
      </Callout>
    );
  }

  if (takiOpen && takiColor) {
    return (
      <Callout
        tone="action"
        urgent
        role="status"
        title={t('game.takiOpenTitle', { color: colorName(t, takiColor) })}
        actions={
          <Button variant="primary" onClick={onCloseTaki}>
            {t('game.closeTaki')}
          </Button>
        }
      >
        {t('game.takiOpenBody', { color: colorName(t, takiColor) })}
      </Callout>
    );
  }

  if (pendingDraw > 0) {
    return (
      <Callout
        tone="action"
        urgent
        role="status"
        actions={
          <Button variant="primary" onClick={onTakeCards}>
            {countLabel(t, 'game.takeCards', pendingDraw)}
          </Button>
        }
      >
        {countLabel(t, 'game.pendingDraw', pendingDraw)}
      </Callout>
    );
  }

  if (freePlay) {
    return (
      <Callout tone="success" icon="crown" role="status">
        {t('game.freePlay')}
      </Callout>
    );
  }

  if (pendingPlus) {
    /*
     * The card owed after a Plus may be paid from the pile, so the way out is a
     * button here as well as a lit draw pile. Without it the prompt reads as an
     * instruction with no alternative, which is what the rule used to be.
     */
    return (
      <Callout
        tone="action"
        urgent
        role="status"
        actions={
          <Button variant="ghost" onClick={onTakeCards}>
            {t('game.plusTakeInstead')}
          </Button>
        }
      >
        {t('game.pendingPlus')}
      </Callout>
    );
  }

  if (playableCount === 0) {
    return (
      <Callout tone="action" urgent role="status">
        {t('game.mustDraw')}
      </Callout>
    );
  }

  return (
    <Callout tone="success" icon="check" role="status">
      {t('game.playOrDraw')}
    </Callout>
  );
}
