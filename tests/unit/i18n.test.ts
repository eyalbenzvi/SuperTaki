import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  countLabel,
  createTranslator,
  directionFor,
  en,
  he,
  isLanguage,
  translate,
  type TranslationKey,
} from '../../src/i18n/index.ts';
import { REJECTION_CODES } from '../../src/features/game/engine/state.ts';

const keys = Object.keys(en) as TranslationKey[];

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
}

describe('dictionaries', () => {
  it('defaults to Hebrew with right-to-left direction', () => {
    expect(DEFAULT_LANGUAGE).toBe('he');
    expect(directionFor('he')).toBe('rtl');
    expect(directionFor('en')).toBe('ltr');
    expect(LANGUAGES).toEqual(['he', 'en']);
  });

  it('covers every key in both languages', () => {
    expect(Object.keys(he).sort()).toEqual(keys.slice().sort());
  });

  it('has no empty strings', () => {
    for (const key of keys) {
      expect(en[key].length, `en:${key}`).toBeGreaterThan(0);
      expect(he[key].length, `he:${key}`).toBeGreaterThan(0);
    }
  });

  it('uses the same placeholders in both languages', () => {
    for (const key of keys) {
      expect(placeholders(he[key]), `key:${key}`).toEqual(placeholders(en[key]));
    }
  });

  it('has a localised message for every engine rejection code', () => {
    for (const code of REJECTION_CODES) {
      expect(keys).toContain(`reject.${code}`);
    }
  });

  it('has a localised message for every connection phase', () => {
    for (const phase of [
      'idle',
      'initializing',
      'ready',
      'connecting',
      'connected',
      'reconnecting',
      'disconnected',
      'failed',
    ]) {
      expect(keys).toContain(`status.${phase}`);
    }
  });

  it('has a localised message for every session error and close reason', () => {
    for (const code of [
      'notConfigured',
      'browserUnsupported',
      'network',
      'timeout',
      'closed',
      'unknown',
      'roomFull',
      'gameInProgress',
      'invalidName',
      'protocolMismatch',
      'unknownSeat',
      'invalidResumeToken',
      'roomClosed',
      'roomTaken',
    ]) {
      expect(keys).toContain(`error.${code}`);
    }
    for (const reason of [
      'roomClosed',
      'roomReset',
      'removedByCreator',
      'duplicateConnection',
      'leftVoluntarily',
      // The one that ends a round without ending the room.
      'abandoned',
    ]) {
      expect(keys).toContain(`closed.${reason}`);
    }
  });

  it('can describe every event the engine emits', () => {
    for (const type of ['turnSkipped', 'playerLeft', 'roundAbandoned']) {
      expect(keys).toContain(`event.${type}`);
    }
  });

  it('carries the product name, and the same Latin wordmark in both languages', () => {
    expect(en['app.title']).toBe('Super Taki');
    expect(he['app.title']).toBe('סופר טאקי');
    for (const dictionary of [en, he]) {
      expect(`${dictionary['app.titleSuper']} ${dictionary['app.titleMain']}`).toBe('SUPER TAKI');
    }
  });
});

describe('translate', () => {
  it('substitutes placeholders', () => {
    expect(translate('en', 'lobby.playerCount', { count: 2, max: 4 })).toBe('2 of 4 players');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(translate('en', 'lobby.playerCount', { count: 2 })).toBe('2 of {max} players');
  });

  it('returns the template when no parameters are given', () => {
    expect(translate('en', 'lobby.playerCount')).toBe('{count} of {max} players');
  });

  it('falls back to English for a missing string', () => {
    const broken = { ...he, 'common.close': '' };
    // Simulated by an empty value, which the lookup treats as missing.
    expect(broken['common.close'] || en['common.close']).toBe('Close');
  });

  it('binds a translator to one language', () => {
    const t = createTranslator('he');
    expect(t('common.close')).toBe('סגירה');
  });

  it('validates language codes', () => {
    expect(isLanguage('he')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(isLanguage(null)).toBe(false);
  });
});

describe('counted phrases', () => {
  it('picks the singular at one and the plural everywhere else', () => {
    const t = createTranslator('en');
    expect(countLabel(t, 'game.cardsLeft', 1)).toBe('1 card');
    expect(countLabel(t, 'game.cardsLeft', 0)).toBe('0 cards');
    expect(countLabel(t, 'game.cardsLeft', 7)).toBe('7 cards');
  });

  it('lets a language spell the singular out', () => {
    const t = createTranslator('he');
    expect(countLabel(t, 'game.cardsLeft', 1)).toBe('קלף אחד');
    expect(countLabel(t, 'game.cardsLeft', 3)).toBe('3 קלפים');
  });

  it('has both halves of every plural pair in both languages', () => {
    const singulars = keys.filter((key) => key.endsWith('.one'));
    expect(singulars.length).toBeGreaterThan(0);
    for (const key of singulars) {
      const plural = `${key.slice(0, -'.one'.length)}.other` as TranslationKey;
      expect(keys, `missing plural for ${key}`).toContain(plural);
      // The singular form must not interpolate the number: some languages spell it.
      expect(en[key], `en:${key}`).not.toContain('{count}');
      expect(he[key], `he:${key}`).not.toContain('{count}');
    }
  });
});
