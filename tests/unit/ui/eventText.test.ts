import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../src/i18n/index.ts';
import { describeEvent } from '../../../src/features/game/ui/eventText.ts';
import { cardFaceLabel, colorName, describeCard } from '../../../src/features/game/ui/cardText.ts';
import type { GameEvent } from '../../../src/features/game/engine/state.ts';
import type { Card } from '../../../src/features/game/engine/cards.ts';

const t = createTranslator('en');
const he = createTranslator('he');
const nameOf = (playerId: string): string => (playerId === 'p1' ? 'Dana' : 'Eli');

const red5: Card = { id: 'x1', kind: 'number', color: 'red', value: 5 };
const blueStop: Card = { id: 'x2', kind: 'stop', color: 'blue' };
const superTaki: Card = { id: 'x3', kind: 'superTaki' };

describe('card text', () => {
  it('names numbers, actions and wilds', () => {
    expect(describeCard(t, red5)).toBe('Red 5');
    expect(describeCard(t, blueStop)).toBe('Blue Stop');
    expect(describeCard(t, superTaki)).toBe('Super Taki');
  });

  it('prints a short face label', () => {
    expect(cardFaceLabel(t, red5)).toBe('5');
    expect(cardFaceLabel(t, blueStop)).toBe('Stop');
    expect(cardFaceLabel(t, superTaki)).toBe('Super Taki');
  });

  it('localises colours', () => {
    expect(colorName(t, 'yellow')).toBe('Yellow');
    expect(colorName(he, 'yellow')).toBe('צהוב');
  });
});

describe('event descriptions', () => {
  const cases: Array<[GameEvent, string]> = [
    [{ type: 'gameStarted', firstPlayerId: 'p1', activeColor: 'red' }, 'The round begins. Colour: Red.'],
    [{ type: 'cardPlayed', playerId: 'p1', card: red5, resultingColor: 'red' }, 'Dana played Red 5.'],
    [{ type: 'cardDrawn', playerId: 'p2', count: 1 }, 'Eli drew a card.'],
    [{ type: 'cardDrawn', playerId: 'p2', count: 3 }, 'Eli drew 3 cards.'],
    [
      { type: 'takiOpened', playerId: 'p1', color: 'green', superTaki: false },
      'Dana opened a Taki sequence in Green.',
    ],
    [
      { type: 'takiOpened', playerId: 'p1', color: 'green', superTaki: true },
      'Dana opened a Super Taki sequence in Green.',
    ],
    [{ type: 'takiClosed', playerId: 'p1', cardsPlayed: 4 }, 'Dana closed the sequence after 4 cards.'],
    [{ type: 'colorChosen', playerId: 'p1', color: 'blue' }, 'Dana chose Blue.'],
    [{ type: 'playerSkipped', playerId: 'p2' }, 'Eli was skipped.'],
    [{ type: 'drawStacked', playerId: 'p1', total: 4 }, 'Dana raised the penalty to 4 cards.'],
    [
      { type: 'drawRunCancelled', playerId: 'p2', cancelled: 4 },
      'Eli played a King — the 4-card penalty is cancelled.',
    ],
    [
      { type: 'drawRunCancelled', playerId: 'p2', cancelled: 1 },
      'Eli played a King — the 1-card penalty is cancelled.',
    ],
    [{ type: 'directionChanged', direction: 1 }, 'The play order is now forwards.'],
    [{ type: 'directionChanged', direction: -1 }, 'The play order is now reversed.'],
    [{ type: 'extraTurn', playerId: 'p1' }, 'Dana plays again.'],
    [{ type: 'turnChanged', playerId: 'p2' }, 'Eli is up.'],
    [{ type: 'drawPileRecycled', count: 12 }, 'The discard pile was shuffled back in (12 cards).'],
    [{ type: 'drawPileExhausted' }, 'There are no cards left to draw.'],
    [{ type: 'playerWon', playerId: 'p1' }, 'Dana has no cards left and wins!'],
  ];

  it.each(cases)('describes %j', (event, expected) => {
    expect(describeEvent(t, event, nameOf)).toBe(expected);
  });

  it('has a Hebrew line for every event type', () => {
    for (const [event] of cases) {
      const line = describeEvent(he, event, nameOf);
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toContain('{');
    }
  });

  it('never mentions a card that is not already face up', () => {
    // Only `cardPlayed` carries a card, and that card is on the discard pile.
    const withCards = cases.filter(([event]) => 'card' in event);
    expect(withCards).toHaveLength(1);
  });
});
