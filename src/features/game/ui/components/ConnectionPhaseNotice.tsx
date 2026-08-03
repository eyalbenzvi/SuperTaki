import type { ReactNode } from 'react';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';

const QUIET_PHASES = new Set(['connected', 'idle']);

/**
 * Shows the connection lifecycle whenever it is not simply "connected", and
 * offers a retry plus an honest explanation when it has failed.
 */
export function ConnectionPhaseNotice(): ReactNode {
  const t = useT();
  const phase = useAppStore((state) => state.phase);
  const error = useAppStore((state) => state.error);
  const role = useAppStore((state) => state.role);
  const retryConnection = useAppStore((state) => state.retryConnection);
  const leaveRoom = useAppStore((state) => state.leaveRoom);

  if (QUIET_PHASES.has(phase) && !error) {
    return null;
  }

  const failed = phase === 'failed' || phase === 'disconnected';
  const tone = failed ? 'notice--error' : 'notice--warning';

  return (
    <div className={`notice ${tone}`} role="status" aria-live="polite">
      <strong>{t(`status.${phase}`)}</strong>
      {error ? <span>{t(`error.${error.code}`)}</span> : null}

      {failed ? (
        <details>
          <summary>{t('error.p2pHelpTitle')}</summary>
          <p className="text-small">{t('error.p2pHelpBody')}</p>
        </details>
      ) : null}

      {failed ? (
        <div className="btn-group">
          {error?.retryable && role === 'client' ? (
            <button type="button" className="btn" onClick={retryConnection}>
              {t('common.retry')}
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost" onClick={leaveRoom}>
            {t('error.backHome')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
