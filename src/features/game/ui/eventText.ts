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
    case 'drawStacked':
      return t('event.drawStacked', { name: nameOf(event.playerId), total: event.total });
    case 'effectsCancelled':
      return t('event.effectsCancelled', { name: nameOf(event.playerId) });
    case 'plusThreePlayed':
      return t('event.plusThreePlayed', { name: nameOf(event.playerId) });
    case 'plusThreeBroken':
      return t('event.plusThreeBroken', {
        name: nameOf(event.playerId),
        target: nameOf(event.targetId),
      });
    case 'takiColorChanged':
      return t('event.takiColorChanged', {
        name: nameOf(event.playerId),
        color: colorName(t, event.color),
      });
    case 'lastCardDeclared':
      return t('event.lastCardDeclared', { name: nameOf(event.playerId) });
    case 'lastCardCaught':
      // Both halves of the count take names too, so the plural is picked here
      // rather than through `countLabel`, which only ever passes the number.
      return t(event.penalty === 1 ? 'event.lastCardCaught.one' : 'event.lastCardCaught.other', {
        name: nameOf(event.playerId),
        by: nameOf(event.caughtById),
        count: event.penalty,
      });
    case 'breakerSpent':
      return t(event.penalty === 1 ? 'event.breakerSpent.one' : 'event.breakerSpent.other', {
        name: nameOf(event.playerId),
        count: event.penalty,
      });
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
    case 'turnSkipped':
      // The draw count matters: a skip is free unless the player owed a +2 run,
      // and a returning player deserves to see which of the two happened.
      return event.drew > 0
        ? t('event.turnSkippedDrew', { name: nameOf(event.playerId), count: event.drew })
        : t('event.turnSkipped', { name: nameOf(event.playerId) });
    case 'playerLeft':
      return t('event.playerLeft', { name: nameOf(event.playerId) });
    case 'roundAbandoned':
      return t('event.roundAbandoned');
  }
}
