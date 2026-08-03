import type { Translator } from '../../../i18n/index.ts';
import type { Card, CardColor } from '../engine/cards.ts';
import { isNumberCard, isWildCard } from '../engine/cards.ts';

const COLOR_KEYS = {
  red: 'card.red',
  blue: 'card.blue',
  green: 'card.green',
  yellow: 'card.yellow',
} as const;

const KIND_KEYS = {
  stop: 'card.stop',
  plus: 'card.plus',
  direction: 'card.direction',
  taki: 'card.taki',
  superTaki: 'card.superTaki',
  colorChange: 'card.colorChange',
} as const;

export function colorName(t: Translator, color: CardColor): string {
  return t(COLOR_KEYS[color]);
}

/** Short label printed on the card face. */
export function cardFaceLabel(t: Translator, card: Card): string {
  if (isNumberCard(card)) {
    return String(card.value);
  }
  return t(KIND_KEYS[card.kind]);
}

/** Full accessible description, e.g. "Red 5" or "Super Taki". */
export function describeCard(t: Translator, card: Card): string {
  if (isNumberCard(card)) {
    return t('card.ariaNumber', { color: colorName(t, card.color), value: card.value });
  }
  if (isWildCard(card)) {
    return t('card.ariaWild', { kind: t(KIND_KEYS[card.kind]) });
  }
  return t('card.ariaAction', { color: colorName(t, card.color), kind: t(KIND_KEYS[card.kind]) });
}
