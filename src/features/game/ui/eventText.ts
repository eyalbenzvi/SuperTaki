import type { Translator } from '../../../i18n/index.ts';
import type { GameEvent } from '../engine/state.ts';
import { colorName, describeCard } from './cardText.ts';

/**
 * Turns an engine event into one localised log line.
 *
 * Only public information is ever rendered: a card is named only when it is
 * already face up on the discard pile.
 */
export function describeEvent(t: Translator, event: GameEvent, nameOf: (playerId: string) => string): string {
  switch (event.type) {
    case 'gameStarted':
      return t('event.gameStarted', { color: colorName(t, event.activeColor) });
    case 'cardPlayed':
      return t('event.cardPlayed', {
        name: nameOf(event.playerId),
        card: describeCard(t, event.card),
      });
    case 'cardDrawn':
      return event.count === 1
        ? t('event.cardDrawn', { name: nameOf(event.playerId) })
        : t('event.cardDrawnMany', { name: nameOf(event.playerId), count: event.count });
    case 'takiOpened':
      return t(event.superTaki ? 'event.takiOpenedSuper' : 'event.takiOpened', {
        name: nameOf(event.playerId),
        color: colorName(t, event.color),
      });
    case 'takiClosed':
      return t('event.takiClosed', { name: nameOf(event.playerId), count: event.cardsPlayed });
    case 'colorChosen':
      return t('event.colorChosen', {
        name: nameOf(event.playerId),
        color: colorName(t, event.color),
      });
    case 'playerSkipped':
      return t('event.playerSkipped', { name: nameOf(event.playerId) });
    case 'directionChanged':
      return t(event.direction === 1 ? 'event.directionChangedCw' : 'event.directionChangedCcw');
    case 'extraTurn':
      return t('event.extraTurn', { name: nameOf(event.playerId) });
    case 'turnChanged':
      return t('event.turnChanged', { name: nameOf(event.playerId) });
    case 'drawPileRecycled':
      return t('event.drawPileRecycled', { count: event.count });
    case 'drawPileExhausted':
      return t('event.drawPileExhausted');
    case 'playerWon':
      return t('event.playerWon', { name: nameOf(event.playerId) });
  }
}
