import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '../../../../components/Button.tsx';
import { Callout } from '../../../../components/Callout.tsx';
import { useT } from '../../../../app/useT.ts';
import { countLabel, type Translator } from '../../../../i18n/index.ts';
import { requiresColorChoice, type Card, type CardColor } from '../../engine/cards.ts';
import {
  canBreakPlusThree,
  currentPlayerName,
  isMyTurn,
  isTakiOpenForMe,
  opponents,
  playableCardIds,
  playerName,
  sortHandForDisplay,
  type TableSnapshot,
} from '../../state/selectors.ts';
import { useAppStore, type FeedEntry } from '../../state/store.ts';
import { colorName } from '../cardText.ts';
import { describeEvent } from '../eventText.ts';
import { ColorPickerModal } from '../components/ColorPickerModal.tsx';
import { ConnectionPhaseNotice } from '../components/ConnectionPhaseNotice.tsx';
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
  const playCard = useAppStore((state) => state.playCard);
  const drawCard = useAppStore((state) => state.drawCard);
  const closeTaki = useAppStore((state) => state.closeTaki);
  const passBreak = useAppStore((state) => state.passBreak);
  const announce = useAppStore((state) => state.announce);

  const [pendingWild, setPendingWild] = useState<Card | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { publicState, feed, actionPending } = table;
  const myTurn = isMyTurn(table);
  const playable = playableCardIds(table);
  const takiOpen = isTakiOpenForMe(table);
  const cards = useMemo(() => sortHandForDisplay(table.hand), [table.hand]);
  const seats = useMemo(() => opponents(table), [table]);
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
      </div>

      <OpponentList opponents={seats} t={t} />

      {/* Outside the scrollable region below: on a short screen, whose turn it is
          is the last thing that should ever scroll out of sight. */}
      <div className="turn-row">
        <p className={`turn-banner ${myTurn ? 'turn-banner--mine' : ''}`.trim()}>
          {myTurn ? t('game.yourTurn') : t('game.turnOf', { name: turnName ?? '—' })}
        </p>
        <DirectionIndicator direction={publicState.direction} t={t} />
      </div>

      <div className="game__table">
        <Piles
          t={t}
          discardTop={publicState.discardTop}
          drawPileCount={publicState.drawPileCount}
          activeColor={publicState.activeColor}
          canDraw={canDraw}
          onDraw={drawCard}
          drawBlockedReason={
            publicState.takiMode ? t('reject.cannotDrawDuringTaki') : t('game.drawPileBlocked')
          }
        />
      </div>

      <GameLog
        feed={feed}
        t={t}
        describe={(entry) => describeEvent(t, entry.event, (id) => playerName(table, id))}
      />

      <div className="game__action">
        {refusal ? (
          <Callout tone="warning" role="alert">
            {refusal}
          </Callout>
        ) : (
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
        )}
      </div>

      <div className="game__hand">
        <Hand
          cards={cards}
          playableIds={playable}
          t={t}
          onPlay={onPlay}
          onRefuse={onRefuse}
          locked={actionPending}
          disabledReason={myTurn ? t('game.notPlayable') : t('game.notYourTurn')}
        />
      </div>

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
    return (
      <Callout tone="action" urgent role="status">
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
