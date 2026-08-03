import type { ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Callout } from '../../../../components/Callout.tsx';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';

export interface ResumeCardProps {
  /** What "rejoin" does here: go to the join screen, or actually reconnect. */
  readonly onResume: () => void;
  readonly busy?: boolean;
}

/**
 * The offer to retake a seat this device already held.
 *
 * Shared by the landing and join screens, which had grown two copies of the same
 * markup and could drift apart.
 */
export function ResumeCard({ onResume, busy = false }: ResumeCardProps): ReactNode {
  const t = useT();
  const resumable = useAppStore((state) => state.resumable);
  const forgetResumable = useAppStore((state) => state.forgetResumable);

  if (!resumable) {
    return null;
  }

  return (
    <Callout
      tone="info"
      icon="clockwise"
      title={t('join.resumeTitle')}
      actions={
        <>
          <Button variant="primary" onClick={onResume} busy={busy}>
            {t('join.resumeAction')}
          </Button>
          <Button variant="ghost" onClick={forgetResumable}>
            {t('join.resumeDiscard')}
          </Button>
        </>
      }
    >
      {t('join.resumeBody', { room: resumable.roomCode, name: resumable.displayName })}
    </Callout>
  );
}
