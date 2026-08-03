import { useEffect, type ReactNode } from 'react';
import { Button } from '../components/Button.tsx';
import { Icon } from '../components/Icon.tsx';
import { useAppStore } from '../features/game/state/store.ts';
import { useT } from './useT.ts';

const VISIBLE_MS = 5000;

/**
 * Explains a rejected move. Rejections are the host's answer to an illegal
 * action, so they must be shown rather than swallowed — and they interrupt,
 * because the player believes the move happened.
 *
 * The effect is keyed on the rejection object, whose nonce changes even when the
 * reason repeats, so the same refusal twice restarts the timer instead of
 * looking like nothing happened.
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
      <span className="toast__icon" aria-hidden="true">
        <Icon name="alert" size={1.3} />
      </span>
      <span className="toast__text">
        {t(`reject.${rejection.code}`, takiColor ? { color: t(`card.${takiColor}`) } : undefined)}
      </span>
      <Button
        iconOnly
        icon="close"
        variant="ghost"
        size="sm"
        aria-label={t('common.close')}
        onClick={dismissRejection}
      />
    </div>
  );
}
