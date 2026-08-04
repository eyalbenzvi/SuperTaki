import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Callout } from '../../../../components/Callout.tsx';
import { Modal } from '../../../../components/Modal.tsx';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';
import { playerName, seatedPlayers } from '../../state/selectors.ts';
import { IDLE_TURN_NUDGE_MS, NUDGE_NOTICE_MS } from '../../network/timing.ts';

/**
 * The two things a table needs and did not have: a way to wait, and a way to stop.
 *
 * Both exist because the alternative to them is worse than either. Without a
 * pause, a player whose phone rings is racing a countdown they did not choose;
 * without an agreed ending, a round that has become unplayable can only be
 * abandoned by somebody closing the room on everybody. Between them they also
 * remove most of the reason to attempt an automatic host takeover, which in this
 * topology cannot be made safe.
 */
export function TableControls(): ReactNode {
  const t = useT();
  const lobby = useAppStore((state) => state.lobby);
  const pausedBy = useAppStore((state) => state.pausedBy);
  const publicState = useAppStore((state) => state.publicState);
  const setPaused = useAppStore((state) => state.setPaused);
  const voteAbandon = useAppStore((state) => state.voteAbandon);
  const [abandonOpen, setAbandonOpen] = useState(false);

  if (!publicState || publicState.phase !== 'playing') {
    return null;
  }

  const agreed = lobby?.abandonVotes?.length ?? 0;
  /*
   * Counted the way the host counts it — fully connected seats that are still in
   * the round. `connectedCount` includes unstable seats, so "1 of 2 agreed" could
   * sit there for ever while the host was waiting on a number that never arrives.
   */
  const required = seatedPlayers({ lobby }).filter(
    (player) => player.health === 'connected' && player.left !== true,
  ).length;
  const paused = pausedBy !== null;

  return (
    <div className="table-controls">
      <Button
        variant="ghost"
        onClick={() => {
          setPaused(!paused);
        }}
      >
        {paused ? t('pause.resume') : t('pause.request')}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setAbandonOpen(true);
        }}
      >
        {t('abandon.request')}
      </Button>

      <Modal
        open={abandonOpen}
        title={t('abandon.title')}
        onClose={() => {
          setAbandonOpen(false);
          voteAbandon(false);
        }}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setAbandonOpen(false);
                voteAbandon(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                voteAbandon(true);
              }}
            >
              {t('abandon.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('abandon.body')}</p>
        <p>{t('abandon.votes', { count: agreed, required })}</p>
      </Modal>
    </div>
  );
}

/**
 * A nudge for a player who is connected and simply not looking.
 *
 * Ten times more common than a disconnect and indistinguishable from one at the
 * table, so it needs an answer that is *not* a timer: a player who is present
 * should never have their turn played for them, but somebody should be able to
 * say "we're waiting on you" without leaving the app.
 */
export function NudgeButton(): ReactNode {
  const t = useT();
  const lobby = useAppStore((state) => state.lobby);
  const publicState = useAppStore((state) => state.publicState);
  const localPlayerId = useAppStore((state) => state.localPlayerId);
  const nudgePlayer = useAppStore((state) => state.nudgePlayer);
  const [sentFor, setSentFor] = useState<string | null>(null);

  const waitingFor = lobby?.waitingFor ?? null;
  const reason = lobby?.waitingReason ?? null;
  /*
   * Only after the table has actually been waiting a while. Offering this the
   * instant it becomes somebody's turn turns a courtesy into a way to hurry
   * people, and a turn in this game takes five to fifteen seconds. Both readings
   * are the host's, so the skew between devices cancels.
   */
  const waitedMs =
    lobby?.waitingSince !== null && lobby?.waitingSince !== undefined && lobby.sentAt !== undefined
      ? lobby.sentAt - lobby.waitingSince
      : 0;
  if (
    !publicState ||
    publicState.phase !== 'playing' ||
    reason !== 'turn' ||
    waitingFor === null ||
    waitingFor === localPlayerId ||
    waitedMs < IDLE_TURN_NUDGE_MS
  ) {
    return null;
  }
  const target = seatedPlayers({ lobby }).find((player) => player.id === waitingFor);
  if (!target || target.health !== 'connected') {
    return null;
  }
  return (
    <Button
      variant="ghost"
      onClick={() => {
        nudgePlayer(waitingFor);
        setSentFor(waitingFor);
      }}
      // Remembered per player, not once for the session: a single flag meant one
      // nudge disabled the button for the rest of the round, including for
      // somebody else entirely.
      disabled={sentFor === waitingFor}
    >
      {sentFor === waitingFor ? t('nudge.sent') : t('nudge.send')}
    </Button>
  );
}

/**
 * The other end of the nudge: what the player who was nudged actually sees.
 *
 * Without this the whole feature was a button that sent a message into nothing —
 * the wire carried it, the store recorded it, and the app never said a word. It is
 * an `alert` rather than a status because the entire point is to reach somebody who
 * is not looking at the screen, and it clears itself: a notice about a turn is
 * worthless once the turn has moved on, and nobody should have to dismiss a nag.
 */
export function NudgeNotice(): ReactNode {
  const t = useT();
  const nudge = useAppStore((state) => state.nudge);
  const lobby = useAppStore((state) => state.lobby);
  const publicState = useAppStore((state) => state.publicState);
  const dismissNudge = useAppStore((state) => state.dismissNudge);

  const nonce = nudge?.nonce ?? null;
  useEffect(() => {
    if (nonce === null) {
      return;
    }
    const timer = setTimeout(() => {
      dismissNudge();
    }, NUDGE_NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [nonce, dismissNudge]);

  if (!nudge) {
    return null;
  }
  const from = playerName({ publicState, lobby }, nudge.fromPlayerId);
  return (
    <Callout
      tone="action"
      icon="alert"
      role="alert"
      urgent
      actions={
        <Button variant="ghost" onClick={dismissNudge}>
          {t('common.close')}
        </Button>
      }
    >
      {t('nudge.received', { name: from })}
    </Callout>
  );
}
