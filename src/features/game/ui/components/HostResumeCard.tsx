import type { ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Callout } from '../../../../components/Callout.tsx';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';

/**
 * The offer to take back a room this device was hosting.
 *
 * This is the single most valuable thing in the resilience work, because it undoes
 * the most common way a table lost an evening: the host reloaded, and the game —
 * which existed only in that one tab's memory — was gone, with nothing having
 * gone wrong on anybody's network. Accepting reclaims the *same* room code, so
 * every invite already sent still works and every guest's stored credential still
 * fits; they reconnect on their own without being told anything.
 */
export function HostResumeCard(): ReactNode {
  const t = useT();
  const hostable = useAppStore((state) => state.hostable);
  const busy = useAppStore((state) => state.busy);
  const resumeHosting = useAppStore((state) => state.resumeHosting);
  const forgetHostable = useAppStore((state) => state.forgetHostable);

  if (!hostable) {
    return null;
  }

  return (
    <Callout
      tone="action"
      icon="clockwise"
      title={t('host.resumeTitle')}
      actions={
        <>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => {
              void resumeHosting();
            }}
          >
            {busy ? t('host.reclaiming') : t('host.resumeAction')}
          </Button>
          <Button variant="ghost" onClick={forgetHostable}>
            {t('host.resumeDiscard')}
          </Button>
        </>
      }
    >
      {t('host.resumeBody', { room: hostable.roomCode })}
    </Callout>
  );
}
