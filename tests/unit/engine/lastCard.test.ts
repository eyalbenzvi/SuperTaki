import { describe, expect, it } from 'vitest';
import { LAST_CARD_PENALTY } from '../../../src/features/game/engine/cards.ts';
import { applyCommand } from '../../../src/features/game/engine/engine.ts';
import { toPublicGameState } from '../../../src/features/game/engine/views.ts';
import {
  cards,
  eventTypes,
  expectOk,
  expectRejected,
  makeState,
  players,
} from '../helpers/engineFixtures.ts';

/** Plays the first card in a player's hand. */
function play(state: ReturnType<typeof makeState>, playerId: string) {
  const cardId = (state.hands[playerId] ?? [])[0]!.id;
  return applyCommand(state, { type: 'playCard', playerId, cardId });
}

function declare(state: ReturnType<typeof makeState>, playerId: string) {
  return applyCommand(state, { type: 'declareLastCard', playerId });
}

describe('declaring the last card', () => {
  it('is legal exactly while the hand is one card', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(declare(state, 'p-alice'));
    expect(next.declaredLastCard).toEqual(['p-alice']);
    expect(eventTypes(events)).toEqual(['lastCardDeclared']);

    expectRejected(declare(next, 'p-alice'), 'alreadyDeclared');
    expectRejected(declare(next, 'p-bob'), 'nothingToDeclare');
  });

  it('is legal out of turn, because the shout is not a move', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:1', 'blue:3'), 'p-bob': cards('red:3') },
      discardPile: cards('red:9'),
      currentPlayerIndex: 0,
    });
    const { state: next } = expectOk(declare(state, 'p-bob'));
    expect(next.declaredLastCard).toEqual(['p-bob']);
    // The turn is untouched: declaring is not playing.
    expect(next.currentPlayerIndex).toBe(0);
  });

  it('is legal while a +3 has the rest of the table frozen', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('red:1', 'red:4'),
        'p-bob': cards('breakPlusThree'),
        'p-carol': cards('red:5', 'red:6'),
      },
      discardPile: cards('plusThree'),
      plusThree: { playerId: 'p-alice', awaiting: ['p-bob'] },
    });
    // Every other command from Bob's seat is refused while the window is open.
    expectRejected(applyCommand(state, { type: 'drawCard', playerId: 'p-bob' }), 'awaitingBreak');
    const { state: next } = expectOk(declare(state, 'p-bob'));
    expect(next.declaredLastCard).toEqual(['p-bob']);
    expect(next.plusThree).not.toBeNull();
  });

  it('lapses as soon as the hand grows again', () => {
    const declared = expectOk(
      declare(
        makeState({
          hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
          discardPile: cards('red:9'),
          drawPile: cards('green:4', 'green:5'),
        }),
        'p-alice',
      ),
    ).state;
    expect(declared.declaredLastCard).toEqual(['p-alice']);

    // Alice draws instead of playing, so the declaration no longer describes
    // her hand and she owes a fresh one next time she is down to a single card.
    const { state: next } = expectOk(applyCommand(declared, { type: 'drawCard', playerId: 'p-alice' }));
    expect(next.declaredLastCard).toEqual([]);
  });

  it('is published to the whole table', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
    });
    const declared = expectOk(declare(state, 'p-alice')).state;
    expect(toPublicGameState(declared).declaredLastCard).toEqual(['p-alice']);
    expect(toPublicGameState(state).declaredLastCard).toEqual([]);
  });
});

describe('playing the last card without declaring', () => {
  it('draws the penalty instead of winning the round', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5', 'green:6'),
    });
    const { state: next, events } = expectOk(play(state, 'p-alice'));

    expect(next.phase).toBe('playing');
    expect(next.winnerId).toBeNull();
    expect(next.hands['p-alice']).toHaveLength(LAST_CARD_PENALTY);
    expect(eventTypes(events)).toEqual(['cardPlayed', 'lastCardMissed', 'cardDrawn', 'turnChanged']);
    // The card itself still counts: it is on the pile and it set the colour.
    expect(next.activeColor).toBe('red');
    expect(next.discardPile).toHaveLength(2);
  });

  it('still resolves the effect of the card that was played', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('red:stop'),
        'p-bob': cards('red:1'),
        'p-carol': cards('red:4'),
      },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5', 'green:6'),
    });
    const { state: next, events } = expectOk(play(state, 'p-alice'));
    expect(eventTypes(events)).toContain('playerSkipped');
    // Bob is skipped by the Stop, so it is Carol's turn.
    expect(next.currentPlayerIndex).toBe(2);
    expect(next.hands['p-alice']).toHaveLength(LAST_CARD_PENALTY);
  });

  it('wins after declaring, on the very same hand', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
    });
    const declared = expectOk(declare(state, 'p-alice')).state;
    const { state: next } = expectOk(play(declared, 'p-alice'));
    expect(next.phase).toBe('finished');
    expect(next.winnerId).toBe('p-alice');
  });

  it('keeps a taki sequence going rather than ending the round', () => {
    const state = makeState({
      takiMode: { color: 'red', playerId: 'p-alice', cardsPlayed: 1, openedWithSuperTaki: false },
      hands: { 'p-alice': cards('red:6'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:taki'),
      activeColor: 'red',
      drawPile: cards('red:4', 'green:5', 'green:6'),
    });
    const { state: next } = expectOk(play(state, 'p-alice'));
    expect(next.phase).toBe('playing');
    expect(next.takiMode).not.toBeNull();
    expect(next.hands['p-alice']).toHaveLength(LAST_CARD_PENALTY);
  });

  it('pays what it can when the pile has to be recycled to find it', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
      drawPile: [],
    });
    const { state: next, events } = expectOk(play(state, 'p-alice'));
    // Nothing to draw, so the discard is recycled: the card just played stays
    // face up and the red 9 under it becomes the whole draw pile — one card of
    // the two owed.
    expect(next.phase).toBe('playing');
    expect(next.hands['p-alice']).toHaveLength(1);
    expect(eventTypes(events)).toEqual([
      'cardPlayed',
      'lastCardMissed',
      'drawPileRecycled',
      'drawPileExhausted',
      'cardDrawn',
      'turnChanged',
    ]);
  });

  it('awards the round when there is nothing at all left to draw', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      // No discard under the played card either, so recycling finds nothing.
      discardPile: [],
      drawPile: [],
      activeColor: 'red',
    });
    const { state: next, events } = expectOk(play(state, 'p-alice'));
    // Play cannot continue against an empty hand, so the round is the only
    // coherent outcome — the penalty simply could not be paid.
    expect(next.phase).toBe('finished');
    expect(next.winnerId).toBe('p-alice');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'lastCardMissed', 'drawPileExhausted', 'playerWon']);
  });
});
