import type { ReactNode } from 'react';
import { Button } from '../components/Button.tsx';
import { Modal } from '../components/Modal.tsx';
import { isHost, seatedPlayers } from '../features/game/state/selectors.ts';
import { useAppStore } from '../features/game/state/store.ts';
import { useT } from './useT.ts';

/**
 * The one confirmation for leaving, wherever the request came from — the top
 * bar, the end-of-round screen, or the Back button.
 *
 * The warning is written for the seat the player actually holds. For a host it
 * used to be a plain statement that the room would close for everybody, which was
 * true and also the end of the matter. It is now a choice: hand the room to
 * somebody who is here and the round carries on without them, or close it.
 *
 * A handover is safe precisely because the host is alive and cooperating when it
 * happens, on channels every seat already trusts. That is the condition an
 * automatic takeover from a silent host can never satisfy, which is why this
 * exists and that does not.
 */
export function LeaveRoomDialog(): ReactNode {
  const t = useT();
  const open = useAppStore((state) => state.leaveIntent);
  const screen = useAppStore((state) => state.screen);
  const host = useAppStore(isHost);
  const lobby = useAppStore((state) => state.lobby);
  const localPlayerId = useAppStore((state) => state.localPlayerId);
  const cancelLeave = useAppStore((state) => state.cancelLeave);
  const leaveRoom = useAppStore((state) => state.leaveRoom);
  const handOver = useAppStore((state) => state.handOver);

  const inGame = screen === 'game';

  /** The lowest-seated player who is actually here. */
  const successor = seatedPlayers({ lobby })
    .filter((player) => player.id !== localPlayerId && player.health === 'connected' && !player.left)
    .sort((a, b) => a.seat - b.seat)[0];

  if (host && successor) {
    return (
      <Modal
        open={open}
        title={t('host.handoffTitle')}
        onClose={cancelLeave}
        actions={
          <>
            <Button variant="ghost" onClick={cancelLeave}>
              {t('common.cancel')}
            </Button>
            <Button variant="ghost" icon="leave" onClick={leaveRoom}>
              {t('host.handoffClose')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                handOver(successor.id);
                cancelLeave();
              }}
            >
              {t('host.handoffAction')}
            </Button>
          </>
        }
      >
        <p>{t('host.handoffBody', { name: successor.name })}</p>
      </Modal>
    );
  }

  const title = inGame ? t('game.leaveTitle') : t('lobby.leaveTitle');
  const body = inGame
    ? host
      ? t('game.leaveBodyHost')
      : t('game.leaveBodyGuest')
    : host
      ? t('lobby.leaveBodyHost')
      : t('lobby.leaveBodyGuest');

  return (
    <Modal
      open={open}
      title={title}
      onClose={cancelLeave}
      actions={
        <>
          <Button variant="ghost" onClick={cancelLeave}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" icon="leave" onClick={leaveRoom}>
            {t('common.leave')}
          </Button>
        </>
      }
    >
      <p>{body}</p>
    </Modal>
  );
}
