import { useState, type ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Modal } from '../../../../components/Modal.tsx';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';
import { connectedCount, seatedPlayers } from '../../state/selectors.ts';

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
  const required = connectedCount({ lobby });
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
  const [sent, setSent] = useState(false);

  const waitingFor = lobby?.waitingFor ?? null;
  const reason = lobby?.waitingReason ?? null;
  if (
    !publicState ||
    publicState.phase !== 'playing' ||
    reason !== 'turn' ||
    waitingFor === null ||
    waitingFor === localPlayerId
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
        setSent(true);
      }}
      disabled={sent}
    >
      {sent ? t('nudge.sent') : t('nudge.send')}
    </Button>
  );
}
