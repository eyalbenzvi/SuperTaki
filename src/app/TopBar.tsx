import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { LANGUAGES, type Language } from '../i18n/index.ts';
import { useAppStore } from '../features/game/state/store.ts';
import type { ThemeChoice } from '../features/game/state/persistence.ts';
import { useT } from './useT.ts';

const THEMES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export function TopBar(): ReactNode {
  const t = useT();
  const language = useAppStore((state) => state.language);
  const theme = useAppStore((state) => state.theme);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const setTheme = useAppStore((state) => state.setTheme);

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <BrandMark size="sm" />
      </div>
      <div className="topbar__controls">
        <SegmentedControl<Language>
          label={t('language.label')}
          value={language}
          onChange={setLanguage}
          options={LANGUAGES.map((code) => ({ value: code, label: t(`language.${code}`) }))}
        />
        <SegmentedControl<ThemeChoice>
          label={t('theme.label')}
          value={theme}
          onChange={setTheme}
          options={THEMES.map((choice) => ({ value: choice, label: t(`theme.${choice}`) }))}
        />
      </div>
    </header>
  );
}
