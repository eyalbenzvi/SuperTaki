import { en, type TranslationKey, type Translations } from './en.ts';
import { he } from './he.ts';

export type Language = 'he' | 'en';
export type TextDirection = 'rtl' | 'ltr';

export const LANGUAGES: readonly Language[] = ['he', 'en'];
export const DEFAULT_LANGUAGE: Language = 'he';

const DICTIONARIES: Record<Language, Translations> = { he, en };

export function directionFor(language: Language): TextDirection {
  return language === 'he' ? 'rtl' : 'ltr';
}

export function isLanguage(value: unknown): value is Language {
  return value === 'he' || value === 'en';
}

export type TranslationParams = Readonly<Record<string, string | number>>;

/**
 * Looks up a key and substitutes `{placeholders}`.
 * Falls back to English, then to the key itself, so a missing string is visible
 * in development rather than rendering as an empty element.
 */
export function translate(language: Language, key: TranslationKey, params?: TranslationParams): string {
  const template = DICTIONARIES[language][key] || en[key] || key;
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export type Translator = (key: TranslationKey, params?: TranslationParams) => string;

export function createTranslator(language: Language): Translator {
  return (key, params) => translate(language, key, params);
}

/**
 * The base of a plural pair: any key for which both `<base>.one` and
 * `<base>.other` exist. Adding one half without the other is a type error at
 * every call site, which is the point.
 */
export type PluralKey = {
  [K in TranslationKey]: K extends `${infer Base}.one`
    ? `${Base}.other` extends TranslationKey
      ? Base
      : never
    : never;
}[TranslationKey];

/**
 * Selects the singular or plural form of a counted phrase.
 *
 * English and Hebrew both split at one, so the rule is shared; a language with
 * more categories would replace this function, not the call sites. The `.one`
 * form never interpolates the number, because some languages spell it out.
 */
export function countLabel(t: Translator, base: PluralKey, count: number): string {
  const key = `${base}.${count === 1 ? 'one' : 'other'}` as TranslationKey;
  return t(key, { count });
}

export type { TranslationKey, Translations };
export { en, he };
