import { useMemo } from 'react';
import { useAppStore } from '../features/game/state/store.ts';
import { createTranslator, directionFor, type TextDirection, type Translator } from '../i18n/index.ts';

/** Translator bound to the currently selected language. */
export function useT(): Translator {
  const language = useAppStore((state) => state.language);
  return useMemo(() => createTranslator(language), [language]);
}

export function useDirection(): TextDirection {
  const language = useAppStore((state) => state.language);
  return directionFor(language);
}
