import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark.tsx';
import { Button } from '../components/Button.tsx';
import { useAppStore } from '../features/game/state/store.ts';
import { useT } from './useT.ts';

export interface TopBarProps {
  readonly onOpenSettings: () => void;
  readonly settingsOpen: boolean;
}

/**
 * One compact row, on every screen.
 *
 * Preferences used to sit here permanently and cost a phone two wrapped rows of
 * chrome — about a fifth of the screen — competing with the table for attention.
 * They are now one control. What stays visible is what a player in a room needs
 * at a glance: where they are, and the way out.
 *
 * The wordmark is dropped on the landing screen, where the hero already carries
 * it at full size.
 *
 * The settings dialog is deliberately *not* rendered in here: the bar carries a
 * `backdrop-filter`, which makes it a containing block, and a fixed-position
 * sheet inside it would be positioned and clipped against the bar instead of the
 * viewport.
 */
export function TopBar({ onOpenSettings, settingsOpen }: TopBarProps): ReactNode {
  const t = useT();
  const screen = useAppStore((state) => state.screen);
  const inRoom = useAppStore((state) => state.inRoom);
  const requestLeave = useAppStore((state) => state.requestLeave);

  return (
    <header className="topbar">
      <div className="topbar__brand">{screen === 'home' ? null : <BrandMark size="sm" />}</div>
      <div className="topbar__controls">
        {inRoom ? (
          <Button
            iconOnly
            icon="leave"
            variant="ghost"
            aria-label={t('common.leave')}
            onClick={requestLeave}
          />
        ) : null}
        <Button
          iconOnly
          icon="settings"
          variant="ghost"
          aria-label={t('app.settings')}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={onOpenSettings}
        />
      </div>
    </header>
  );
}
