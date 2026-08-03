import type { ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Callout } from '../../../../components/Callout.tsx';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';

const QUIET_PHASES = new Set(['connected', 'idle']);

/**
 * The connection, in words a player can act on.
 *
 * Three different situations used to look the same. They are now told apart: a
 * device with no internet is told to check its own network, a link being
 * re-established says the seat is being held, and a connection that has
 * genuinely failed gets the honest peer-to-peer explanation plus a way out.
 * Nothing is said at all while everything works.
 */
export function ConnectionPhaseNotice(): ReactNode {
  const t = useT();
  const phase = useAppStore((state) => state.phase);
  const error = useAppStore((state) => state.error);
  const role = useAppStore((state) => state.role);
  const online = useAppStore((state) => state.online);
  const retryConnection = useAppStore((state) => state.retryConnection);
  const leaveRoom = useAppStore((state) => state.leaveRoom);

  if (!online) {
    return (
      <Callout tone="warning" icon="offline" title={t('status.offline')} role="status">
        {t('status.offlineBody')}
      </Callout>
    );
  }

  if (QUIET_PHASES.has(phase) && !error) {
    return null;
  }

  const failed = phase === 'failed' || phase === 'disconnected';
  const reconnecting = phase === 'reconnecting' || phase === 'connecting';

  if (!failed) {
    return (
      <Callout
        tone="info"
        icon={reconnecting ? 'hourglass' : 'info'}
        title={t(`status.${phase}`)}
        role="status"
      >
        {error ? t(`error.${error.code}`) : reconnecting ? t('status.reconnectingBody') : null}
      </Callout>
    );
  }

  return (
    <Callout
      tone="danger"
      title={t(`status.${phase}`)}
      role="status"
      actions={
        <>
          {error?.retryable && role === 'client' ? (
            <Button icon="clockwise" onClick={retryConnection}>
              {t('common.retry')}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={leaveRoom}>
            {t('error.backHome')}
          </Button>
        </>
      }
    >
      {error ? <p>{t(`error.${error.code}`)}</p> : null}
      <details className="disclosure">
        <summary>{t('error.p2pHelpTitle')}</summary>
        <p className="text-small">{t('error.p2pHelpBody')}</p>
      </details>
    </Callout>
  );
}
