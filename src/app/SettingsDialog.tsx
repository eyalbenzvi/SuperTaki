import { useState, type ReactNode } from 'react';
import { Button } from '../components/Button.tsx';
import { Modal } from '../components/Modal.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { LANGUAGES, type Language } from '../i18n/index.ts';
import { copyText } from '../lib/share.ts';
import type { ThemeChoice } from '../features/game/state/persistence.ts';
import { useAppStore } from '../features/game/state/store.ts';
import { TableControls } from '../features/game/ui/components/TableControls.tsx';
import { DiagnosticsPanel } from './DiagnosticsPanel.tsx';
import { useT } from './useT.ts';

const THEMES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export interface SettingsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * Language, theme, and — while seated in a room — the room code.
 *
 * These are set-once preferences, so they live behind one control instead of
 * occupying the top of every screen. The room code is here because a player
 * whose friend cannot get in needs it mid-game, and nowhere else on the table
 * should be spending space on it.
 */
export function SettingsDialog({ open, onClose }: SettingsDialogProps): ReactNode {
  const t = useT();
  const language = useAppStore((state) => state.language);
  const theme = useAppStore((state) => state.theme);
  const sound = useAppStore((state) => state.sound);
  const setSound = useAppStore((state) => state.setSound);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const setTheme = useAppStore((state) => state.setTheme);
  const roomCode = useAppStore((state) => state.roomCode);
  const [copied, setCopied] = useState(false);

  return (
    <Modal
      open={open}
      title={t('app.settingsTitle')}
      onClose={onClose}
      closeLabel={t('common.close')}
      actions={
        <Button variant="primary" onClick={onClose}>
          {t('common.done')}
        </Button>
      }
    >
      <div className="stack">
        <div className="field">
          <span className="field__label">{t('language.label')}</span>
          <SegmentedControl<Language>
            block
            label={t('language.label')}
            value={language}
            onChange={setLanguage}
            options={LANGUAGES.map((code) => ({ value: code, label: t(`language.${code}`) }))}
          />
        </div>

        <div className="field">
          <span className="field__label">{t('theme.label')}</span>
          <SegmentedControl<ThemeChoice>
            block
            label={t('theme.label')}
            value={theme}
            onChange={setTheme}
            options={THEMES.map((choice) => ({ value: choice, label: t(`theme.${choice}`) }))}
          />
        </div>

        {/*
          A third preference beside the two that were already here, because that is
          what it is: set once, and then never thought about again.
         */}
        <div className="field">
          <span className="field__label">{t('sound.label')}</span>
          <SegmentedControl<'on' | 'off'>
            block
            label={t('sound.label')}
            value={sound ? 'on' : 'off'}
            onChange={(value) => {
              setSound(value === 'on');
            }}
            options={[
              { value: 'on', label: t('sound.on') },
              { value: 'off', label: t('sound.off') },
            ]}
          />
        </div>

        {roomCode ? (
          <div className="field">
            <span className="field__label">{t('lobby.roomCode')}</span>
            <div className="row row--between">
              <span className="code-value">{roomCode}</span>
              <Button
                size="sm"
                icon={copied ? 'check' : 'copy'}
                onClick={() => {
                  void copyText(roomCode).then(setCopied);
                }}
              >
                {copied ? t('common.copied') : t('common.copyCode')}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Asking the table to wait, and agreeing to stop. Reachable in two taps
            from every screen, without spending a row of the table on them. */}
        <TableControls />

        <DiagnosticsPanel />
      </div>
    </Modal>
  );
}
