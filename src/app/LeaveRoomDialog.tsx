import type { ReactNode } from 'react';
import { Button } from '../components/Button.tsx';
import { Modal } from '../components/Modal.tsx';
import { isHost } from '../features/game/state/selectors.ts';
import { useAppStore } from '../features/game/state/store.ts';
import { useT } from './useT.ts';

/**
 * The one confirmation for leaving, wherever the request came from — the top
 * bar, the end-of-round screen, or the Back button.
 *
 * The warning is written for the seat the player actually holds: a host is told
 * plainly that the room closes for everyone, because that is the consequence
 * they cannot undo.
 */
export function LeaveRoomDialog(): ReactNode {
  const t = useT();
  const open = useAppStore((state) => state.leaveIntent);
  const screen = useAppStore((state) => state.screen);
  const host = useAppStore(isHost);
  const cancelLeave = useAppStore((state) => state.cancelLeave);
  const leaveRoom = useAppStore((state) => state.leaveRoom);

  const inGame = screen === 'game';
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
