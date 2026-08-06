import type { ReactNode } from 'react';
import { Button } from '../components/Button.tsx';
import { Modal } from '../components/Modal.tsx';
import { amCreator } from '../features/game/state/selectors.ts';
import { useAppStore } from '../features/game/state/store.ts';
import { useT } from './useT.ts';

/**
 * The one confirmation for leaving, wherever the request came from — the top bar,
 * the end-of-round screen, or the Back button.
 *
 * It used to be two dialogs and a negotiation. Leaving as the host closed the room
 * for everybody, so the dialog had to say so; and because that was a miserable thing
 * to be told, it also offered to hand the room to another player, wait for them to
 * accept, and step down only once they were serving.
 *
 * None of that is a question any more. The room is not in anybody's tab, so leaving
 * is leaving: the table carries on, and the only thing that changes for the others is
 * that one seat is empty. If the seat holding the lobby buttons goes, they pass to
 * the next player — which is the one line here that still depends on who you are.
 */
export function LeaveRoomDialog(): ReactNode {
  const t = useT();
  const open = useAppStore((state) => state.leaveIntent);
  const screen = useAppStore((state) => state.screen);
  const creator = useAppStore(amCreator);
  const cancelLeave = useAppStore((state) => state.cancelLeave);
  const leaveRoom = useAppStore((state) => state.leaveRoom);

  const inGame = screen === 'game';
  const title = inGame ? t('game.leaveTitle') : t('lobby.leaveTitle');
  const body = inGame ? t('game.leaveBody') : t('lobby.leaveBody');

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
      {creator ? <p className="text-small muted">{t('leave.creatorNote')}</p> : null}
    </Modal>
  );
}
