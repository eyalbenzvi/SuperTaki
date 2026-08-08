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

function catchOut(state: ReturnType<typeof makeState>, playerId: string, targetId: string) {
  return applyCommand(state, { type: 'catchLastCard', playerId, targetId });
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

describe('shouting with the card', () => {
  /** Plays a card by spec, shouting in the same move. */
  function playAndDeclare(state: ReturnType<typeof makeState>, playerId: string, spec: string) {
    const match = (state.hands[playerId] ?? []).find((candidate) => candidate.id.startsWith(`${spec}#`));
    if (!match) {
      throw new Error(`${spec} not in hand`);
    }
    return applyCommand(state, {
      type: 'playCard',
      playerId,
      cardId: match.id,
      declareLastCard: true,
      ...(match.kind === 'colorChange' ? { chosenColor: 'blue' as const } : {}),
    });
  }

  it('declares in the same move, so there is no window to be caught in', () => {
    const state = makeState({
      hands: { 'p-alice': cards('colorChange', 'red:3'), 'p-bob': cards('red:1', 'blue:4') },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(playAndDeclare(state, 'p-alice', 'colorChange'));

    expect(next.declaredLastCard).toEqual(['p-alice']);
    expect(eventTypes(events)).toEqual(['cardPlayed', 'colorChosen', 'lastCardDeclared', 'turnChanged']);
    // Which is the whole point: the state the table is first shown already has
    // the shout in it.
    expectRejected(catchOut(next, 'p-bob', 'p-alice'), 'nothingToCatch');
  });

  it('is ignored when the play does not leave exactly one card', () => {
    // Three in hand: the flag is a shout about a card the player is not yet on.
    const early = makeState({
      hands: { 'p-alice': cards('red:3', 'red:4', 'red:5'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    expect(expectOk(playAndDeclare(early, 'p-alice', 'red:3')).state.declaredLastCard).toEqual([]);

    // And a play that empties the hand ends the round; there is nothing to declare.
    const winning = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:4') },
      discardPile: cards('red:9'),
    });
    const won = expectOk(playAndDeclare(winning, 'p-alice', 'red:3')).state;
    expect(won.winnerId).toBe('p-alice');
    expect(won.declaredLastCard).toEqual([]);
  });

  it('is not a way of declaring twice', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3', 'red:4'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    const next = expectOk(playAndDeclare(state, 'p-alice', 'red:3')).state;
    expect(next.declaredLastCard).toEqual(['p-alice']);
    expectRejected(declare(next, 'p-alice'), 'alreadyDeclared');
  });

  it('does not fire for a breaker that draws its own penalty', () => {
    // The three cards land before the hand is counted, so the player is not on a
    // last card at all — the same reason a breaker cannot win the round.
    const state = makeState({
      hands: { 'p-alice': cards('breakPlusThree', 'red:4'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5', 'green:6'),
    });
    const next = expectOk(playAndDeclare(state, 'p-alice', 'breakPlusThree')).state;
    expect((next.hands['p-alice'] ?? []).length).toBe(4);
    expect(next.declaredLastCard).toEqual([]);
  });
});

describe('being caught on a silent last card', () => {
  it('makes the silent player draw the penalty, called from any seat', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5', 'green:6', 'green:7', 'green:8'),
      currentPlayerIndex: 0,
    });
    // Bob calls it out on Alice's turn, which is the usual way it happens.
    const { state: next, events } = expectOk(catchOut(state, 'p-bob', 'p-alice'));

    expect(next.hands['p-alice']).toHaveLength(1 + LAST_CARD_PENALTY);
    expect(eventTypes(events)).toEqual(['lastCardCaught', 'cardDrawn']);
    expect(events[0]).toMatchObject({
      type: 'lastCardCaught',
      playerId: 'p-alice',
      caughtById: 'p-bob',
      penalty: LAST_CARD_PENALTY,
    });
    // Nothing else about the table moves: it is a call, not a move.
    expect(next.currentPlayerIndex).toBe(0);
    expect(next.discardPile).toHaveLength(1);
  });

  it('cannot be called on a player who declared, or on a bigger hand, or on yourself', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
    });
    expectRejected(catchOut(state, 'p-alice', 'p-bob'), 'nothingToCatch');
    expectRejected(catchOut(state, 'p-alice', 'p-alice'), 'nothingToCatch');
    expectRejected(catchOut(state, 'p-bob', 'p-nobody'), 'nothingToCatch');

    const declared = expectOk(declare(state, 'p-alice')).state;
    expectRejected(catchOut(declared, 'p-bob', 'p-alice'), 'nothingToCatch');
  });

  it('closes the window by itself: the penalty ends the single-card hand', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5', 'green:6', 'green:7'),
    });
    const caught = expectOk(catchOut(state, 'p-bob', 'p-alice')).state;
    expectRejected(catchOut(caught, 'p-bob', 'p-alice'), 'nothingToCatch');
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
      drawPile: cards('green:4', 'green:5', 'green:6', 'green:7'),
      plusThree: { playerId: 'p-alice', awaiting: ['p-bob'] },
    });
    const { state: next } = expectOk(catchOut(state, 'p-carol', 'p-bob'));
    expect(next.hands['p-bob']).toHaveLength(1 + LAST_CARD_PENALTY);
    // The +3 is still waiting: catching somebody out did not settle it.
    expect(next.plusThree).not.toBeNull();
  });
});

describe('the last card itself', () => {
  it('wins the round whether or not it was declared', () => {
    const silent = makeState({
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5'),
    });
    const { state: next, events } = expectOk(play(silent, 'p-alice'));
    expect(next.phase).toBe('finished');
    expect(next.winnerId).toBe('p-alice');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'playerWon']);

    const declared = expectOk(declare(silent, 'p-alice')).state;
    expect(expectOk(play(declared, 'p-alice')).state.winnerId).toBe('p-alice');
  });
});
