import { useEffect, type ReactNode } from 'react';
import { useAppStore } from '../features/game/state/store.ts';
import { useT } from './useT.ts';

const VISIBLE_MS = 4000;

/**
 * Explains a rejected move. Rejections are the host's answer to an illegal
 * action, so they must be shown rather than swallowed.
 */
export function RejectionToast(): ReactNode {
  const t = useT();
  const rejection = useAppStore((state) => state.rejection);
  const dismissRejection = useAppStore((state) => state.dismissRejection);
  const takiColor = useAppStore((state) => state.publicState?.takiMode?.color ?? null);

  useEffect(() => {
    if (!rejection) {
      return;
    }
    const timer = setTimeout(dismissRejection, VISIBLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [rejection, dismissRejection]);

  if (!rejection) {
    return null;
  }

  return (
    <div className="toast" role="alert">
      <span>{t(`reject.${rejection.code}`, takiColor ? { color: t(`card.${takiColor}`) } : undefined)}</span>
      <button type="button" className="btn btn--ghost" onClick={dismissRejection}>
        {t('common.close')}
      </button>
    </div>
  );
}
