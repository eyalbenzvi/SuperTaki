import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from '../../../../components/Modal.tsx';
import { useT } from '../../../../app/useT.ts';
import { requiresColorChoice, type Card, type CardColor } from '../../engine/cards.ts';
import {
  canBreakPlusThree,
  currentPlayerName,
  isHost,
  isMyTurn,
  isTakiOpenForMe,
  opponents,
  playableCardIds,
  playerName,
} from '../../state/selectors.ts';
import { useAppStore } from '../../state/store.ts';
import { colorName } from '../cardText.ts';
import { describeEvent } from '../eventText.ts';
import { ColorPickerModal } from '../components/ColorPickerModal.tsx';
import { ConnectionPhaseNotice } from '../components/ConnectionPhaseNotice.tsx';
import { ColorIndicator, Hand, OpponentList, Piles } from '../components/TableParts.tsx';

export function GameScreen(): ReactNode {
  const t = useT();
  const state = useAppStore();
  const [pendingWild, setPendingWild] = useState<Card | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const feedRef = useRef<HTMLUListElement>(null);

  const publicState = state.publicState;
  const myTurn = isMyTurn(state);
  const playable = playableCardIds(state);
  const takiOpen = isTakiOpenForMe(state);

  // Keep the newest log line in view without stealing focus.
  useEffect(() => {
    const list = feedRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [state.feed]);

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
    state.playCard(card.id);
  };

  const onChooseColor = (color: CardColor): void => {
    if (pendingWild) {
      state.playCard(pendingWild.id, color);
      setPendingWild(null);
    }
  };

  const onBreakPlusThree = (): void => {
    const breaker = state.hand.find((card) => card.kind === 'breakPlusThree');
    if (breaker) {
      state.playCard(breaker.id);
    }
  };

  const turnLabel = myTurn ? t('game.yourTurn') : t('game.turnOf', { name: currentPlayerName(state) ?? '—' });

  const plusThree = publicState.plusThree;
  const plusThreeName = plusThree ? playerName(state, plusThree.playerId) : null;
  // A +3 freezes the table for everyone until the breaker window closes.
  const myBreak = plusThree !== null && canBreakPlusThree(state);
  const canDraw = myTurn && !publicState.takiMode && plusThree === null;

  return (
    <div className="game">
      <ConnectionPhaseNotice />

      <OpponentList opponents={opponents(state)} t={t} />

      <div className="table-status">
        <p className={`turn-banner ${myTurn ? 'turn-banner--mine' : ''}`.trim()} aria-live="polite">
          {turnLabel}
        </p>
        <ColorIndicator color={publicState.activeColor} t={t} />
        <span className="badge">
          {publicState.direction === 1 ? t('game.directionCw') : t('game.directionCcw')}
        </span>
      </div>

      {takiOpen && publicState.takiMode ? (
        <div className="taki-banner" role="status">
          <div className="taki-banner__text">
            <strong>{t('game.takiOpenTitle', { color: colorName(t, publicState.takiMode.color) })}</strong>
            <p className="text-small">
              {t('game.takiOpenBody', { color: colorName(t, publicState.takiMode.color) })}
            </p>
          </div>
          <button type="button" className="btn btn--primary" onClick={state.closeTaki}>
            {t('game.closeTaki')}
          </button>
        </div>
      ) : null}

      {plusThree ? (
        <div className={`taki-banner ${myBreak ? '' : 'taki-banner--quiet'}`.trim()} role="status">
          <div className="taki-banner__text">
            <strong>{t('game.plusThreeTitle')}</strong>
            <p className="text-small">
              {myBreak
                ? t('game.plusThreeBreakBody', { name: plusThreeName ?? '—' })
                : t('game.plusThreeWaiting', { name: plusThreeName ?? '—' })}
            </p>
          </div>
          {myBreak ? (
            <div className="btn-group">
              <button type="button" className="btn btn--primary" onClick={onBreakPlusThree}>
                {t('game.plusThreeBreak')}
              </button>
              <button type="button" className="btn btn--ghost" onClick={state.passBreak}>
                {t('game.plusThreePass')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {myTurn && plusThree === null && publicState.pendingDraw > 0 ? (
        <div className="notice notice--info" role="status">
          <span>{t('game.pendingDraw', { count: publicState.pendingDraw })}</span>
          <div className="btn-group">
            <button type="button" className="btn" onClick={state.drawCard}>
              {t('game.takeCards', { count: publicState.pendingDraw })}
            </button>
          </div>
        </div>
      ) : null}

      {myTurn && plusThree === null && publicState.freePlay ? (
        <p className="notice notice--info" role="status">
          {t('game.freePlay')}
        </p>
      ) : null}

      {myTurn && plusThree === null && publicState.pendingPlus && !publicState.freePlay ? (
        <p className="notice notice--info" role="status">
          {t('game.pendingPlus')}
        </p>
      ) : null}

      {myTurn &&
      plusThree === null &&
      playable.length === 0 &&
      !publicState.takiMode &&
      publicState.pendingDraw === 0 ? (
        <p className="notice" role="status">
          {t('game.mustDraw')}
        </p>
      ) : null}

      <Piles
        t={t}
        discardTop={publicState.discardTop}
        drawPileCount={publicState.drawPileCount}
        canDraw={canDraw}
        onDraw={state.drawCard}
        drawBlockedReason={
          publicState.takiMode ? t('reject.cannotDrawDuringTaki') : t('game.drawPileBlocked')
        }
      />

      <Hand
        cards={state.hand}
        playableIds={playable}
        t={t}
        onPlay={onPlay}
        disabledReason={myTurn ? t('game.notPlayable') : t('game.drawPileBlocked')}
      />

      <section className="panel panel--flush">
        <h2 className="panel__title">{t('game.feedTitle')}</h2>
        <ul className="feed" ref={feedRef} aria-live="polite" aria-relevant="additions">
          {state.feed.length === 0 ? (
            <li className="feed__item">{t('game.feedEmpty')}</li>
          ) : (
            state.feed.map((entry, index) => (
              <li
                key={entry.id}
                className={`feed__item ${index === state.feed.length - 1 ? 'feed__item--latest' : ''}`.trim()}
              >
                {describeEvent(t, entry.event, (playerId) => playerName(state, playerId))}
              </li>
            ))
          )}
        </ul>
      </section>

      <div className="game-footer">
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => {
            setConfirmLeave(true);
          }}
        >
          {t('common.leave')}
        </button>
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

      <Modal
        open={confirmLeave}
        title={t('game.leaveTitle')}
        onClose={() => {
          setConfirmLeave(false);
        }}
        actions={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setConfirmLeave(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn--danger" onClick={state.leaveRoom}>
              {t('common.leave')}
            </button>
          </>
        }
      >
        <p>{isHost(state) ? t('game.leaveBodyHost') : t('game.leaveBodyGuest')}</p>
      </Modal>
    </div>
  );
}
