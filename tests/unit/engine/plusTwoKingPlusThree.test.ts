import { describe, expect, it } from 'vitest';
import { applyCommand, currentPlayer } from '../../../src/features/game/engine/engine.ts';
import { PLUS_THREE_PENALTY, type CardColor } from '../../../src/features/game/engine/cards.ts';
import type { GameState } from '../../../src/features/game/engine/state.ts';
import { toPublicGameState } from '../../../src/features/game/engine/views.ts';
import {
  cards,
  eventTypes,
  expectOk,
  expectRejected,
  handOf,
  idOf,
  makeState,
  players,
} from '../helpers/engineFixtures.ts';

function play(state: GameState, playerId: string, spec: string, chosenColor?: CardColor) {
  const cardId = idOf(state, playerId, spec);
  return applyCommand(
    state,
    chosenColor
      ? { type: 'playCard', playerId, cardId, chosenColor }
      : { type: 'playCard', playerId, cardId },
  );
}

describe('+2', () => {
  it('makes the next player owe two cards', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:plusTwo', 'blue:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(play(state, 'p-alice', 'red:plusTwo'));
    expect(next.pendingDraw).toBe(2);
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'drawStacked', 'turnChanged']);
  });

  it('accumulates when the run is answered, whatever the colour', () => {
    let state = makeState({
      hands: {
        'p-alice': cards('red:plusTwo', 'blue:3'),
        'p-bob': cards('green:plusTwo', 'blue:3'),
      },
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'red:plusTwo')).state;
    const { state: next, events } = expectOk(play(state, 'p-bob', 'green:plusTwo'));
    expect(next.pendingDraw).toBe(4);
    expect(next.activeColor).toBe('green');
    expect(events.find((event) => event.type === 'drawStacked')).toMatchObject({ total: 4 });
  });

  it('refuses anything but another +2 while a run is open', () => {
    let state = makeState({
      hands: {
        'p-alice': cards('red:plusTwo', 'blue:3'),
        'p-bob': cards('red:1', 'colorChange', 'king'),
      },
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'red:plusTwo')).state;
    expectRejected(play(state, 'p-bob', 'red:1'), 'mustAnswerDraw');
    expectRejected(play(state, 'p-bob', 'colorChange', 'blue'), 'mustAnswerDraw');
    // The King is refused like anything else: it is not an answer to a run.
    expectRejected(play(state, 'p-bob', 'king'), 'mustAnswerDraw');
  });

  it('hands the whole run to whoever cannot answer', () => {
    let state = makeState({
      hands: { 'p-alice': cards('red:plusTwo', 'blue:3'), 'p-bob': cards('red:1', 'red:3') },
      drawPile: cards('green:4', 'green:5', 'green:6', 'green:7'),
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'red:plusTwo')).state;
    const { state: next, events } = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-bob' }));
    expect(handOf(next, 'p-bob')).toHaveLength(4);
    expect(next.pendingDraw).toBe(0);
    expect(currentPlayer(next)?.id).toBe('p-alice');
    expect(events.find((event) => event.type === 'cardDrawn')).toMatchObject({ count: 2 });
  });

  it('resolves at the end of a taki sequence, not inside it', () => {
    let state = makeState({
      hands: {
        'p-alice': cards('red:taki', 'red:plusTwo', 'red:3'),
        'p-bob': cards('blue:1', 'blue:3'),
      },
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'red:taki')).state;
    state = expectOk(play(state, 'p-alice', 'red:plusTwo')).state;
    expect(state.pendingDraw).toBe(0);
    state = expectOk(applyCommand(state, { type: 'closeTaki', playerId: 'p-alice' })).state;
    expect(state.pendingDraw).toBe(2);
    expect(currentPlayer(state)?.id).toBe('p-bob');
  });
});

describe('king', () => {
  it('buys a free turn', () => {
    const state = makeState({
      hands: { 'p-alice': cards('king', 'blue:3'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(play(state, 'p-alice', 'king'));
    expect(next.freePlay).toBe(true);
    expect(next.pendingPlus).toBe(true);
    expect(currentPlayer(next)?.id).toBe('p-alice');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'extraTurn']);
  });

  it('is no answer to a pending run: the holder pays it like anybody else', () => {
    let state = makeState({
      hands: { 'p-alice': cards('red:plusTwo', 'blue:3'), 'p-bob': cards('king', 'blue:3') },
      drawPile: cards('green:4', 'green:5'),
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'red:plusTwo')).state;

    expectRejected(play(state, 'p-bob', 'king'), 'mustAnswerDraw');

    // Bob holds a King and no +2, so the only way out is the whole run.
    const { state: next } = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-bob' }));
    expect(handOf(next, 'p-bob')).toHaveLength(4);
    expect(next.pendingDraw).toBe(0);
    expect(next.freePlay).toBe(false);
    expect(currentPlayer(next)?.id).toBe('p-alice');
  });

  it('leaves the leading colour alone and refuses a colour choice', () => {
    const state = makeState({
      hands: { 'p-alice': cards('king', 'blue:3'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    expectRejected(play(state, 'p-alice', 'king', 'blue'), 'colorNotAllowed');
    expect(expectOk(play(state, 'p-alice', 'king')).state.activeColor).toBe('red');
  });

  it('makes every card in hand legal on the free turn', () => {
    let state = makeState({
      hands: { 'p-alice': cards('king', 'blue:3', 'green:7'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'king')).state;
    const { state: next } = expectOk(play(state, 'p-alice', 'green:7'));
    expect(next.activeColor).toBe('green');
    expect(next.freePlay).toBe(false);
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });
});

describe('+3 and the breaker', () => {
  it('makes everybody else draw three when nobody holds a breaker', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('plusThree', 'blue:3'),
        'p-bob': cards('red:1'),
        'p-carol': cards('red:3'),
      },
      drawPile: cards('green:1', 'green:3', 'green:3', 'green:4', 'green:5', 'green:6'),
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(play(state, 'p-alice', 'plusThree'));
    expect(next.plusThree).toBeNull();
    expect(handOf(next, 'p-bob')).toHaveLength(4);
    expect(handOf(next, 'p-carol')).toHaveLength(4);
    expect(handOf(next, 'p-alice')).toHaveLength(1);
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expect(eventTypes(events)).toContain('plusThreePlayed');
  });

  it('waits for a holder to answer, and freezes the rest of the table', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('plusThree', 'blue:3'),
        'p-bob': cards('red:1', 'breakPlusThree'),
        'p-carol': cards('red:3'),
      },
      discardPile: cards('red:9'),
    });
    const open = expectOk(play(state, 'p-alice', 'plusThree')).state;
    expect(open.plusThree).toEqual({ playerId: 'p-alice', awaiting: ['p-bob'] });

    expectRejected(applyCommand(open, { type: 'drawCard', playerId: 'p-alice' }), 'awaitingBreak');
    expectRejected(play(open, 'p-carol', 'red:3'), 'awaitingBreak');
    expectRejected(applyCommand(open, { type: 'passBreak', playerId: 'p-carol' }), 'noPlusThreeOpen');
  });

  it('sends the three cards back at whoever played the +3', () => {
    let state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('plusThree', 'blue:3'),
        'p-bob': cards('red:1', 'breakPlusThree'),
        'p-carol': cards('red:3'),
      },
      drawPile: cards('green:1', 'green:3', 'green:3'),
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'plusThree')).state;
    // Nobody has drawn yet, and it is still Alice's turn: the breaker is played
    // out of turn, in the window before the +3 takes effect.
    expect(currentPlayer(state)?.id).toBe('p-alice');
    expect(handOf(state, 'p-bob')).toHaveLength(2);
    expect(handOf(state, 'p-carol')).toHaveLength(1);

    const { state: next, events } = expectOk(play(state, 'p-bob', 'breakPlusThree'));

    expect(next.plusThree).toBeNull();
    expect(handOf(next, 'p-alice')).toHaveLength(4);
    expect(handOf(next, 'p-bob')).toHaveLength(1);
    expect(handOf(next, 'p-carol')).toHaveLength(1);
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expect(events.find((event) => event.type === 'plusThreeBroken')).toMatchObject({
      playerId: 'p-bob',
      targetId: 'p-alice',
    });
  });

  it('applies the +3 once the last holder passes', () => {
    let state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('plusThree', 'blue:3'),
        'p-bob': cards('red:1', 'breakPlusThree'),
        'p-carol': cards('red:3', 'breakPlusThree'),
      },
      drawPile: cards('green:1', 'green:3', 'green:3', 'green:4', 'green:5', 'green:6'),
      discardPile: cards('red:9'),
    });
    state = expectOk(play(state, 'p-alice', 'plusThree')).state;
    state = expectOk(applyCommand(state, { type: 'passBreak', playerId: 'p-bob' })).state;
    expect(state.plusThree).toEqual({ playerId: 'p-alice', awaiting: ['p-carol'] });

    const { state: next } = expectOk(applyCommand(state, { type: 'passBreak', playerId: 'p-carol' }));
    expect(next.plusThree).toBeNull();
    expect(handOf(next, 'p-bob')).toHaveLength(5);
    expect(handOf(next, 'p-carol')).toHaveLength(5);
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });

  it('charges a breaker played with no +3 to break to the player who spent it', () => {
    const state = makeState({
      hands: { 'p-alice': cards('breakPlusThree', 'red:3'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5', 'green:6', 'green:7'),
    });
    const { state: next, events } = expectOk(play(state, 'p-alice', 'breakPlusThree'));

    // The card is playable — it is colourless — and the three cards it would have
    // sent back are drawn by its owner instead.
    expect(handOf(next, 'p-alice')).toHaveLength(1 + PLUS_THREE_PENALTY);
    expect(handOf(next, 'p-bob')).toHaveLength(1);
    expect(eventTypes(events)).toEqual(['cardPlayed', 'breakerSpent', 'cardDrawn', 'turnChanged']);
    // The colour is untouched, like every other colourless card.
    expect(next.activeColor).toBe('red');
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });

  it('does not let a spent breaker be a free way out of a last card', () => {
    const state = makeState({
      hands: { 'p-alice': cards('breakPlusThree'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5', 'green:6'),
    });
    const { state: next } = expectOk(play(state, 'p-alice', 'breakPlusThree'));
    // The penalty is charged before the win check, so the hand is not empty.
    expect(next.phase).toBe('playing');
    expect(handOf(next, 'p-alice')).toHaveLength(PLUS_THREE_PENALTY);
  });

  it('still refuses a pass with no +3 open', () => {
    const state = makeState({
      hands: { 'p-alice': cards('breakPlusThree', 'red:3'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    expectRejected(applyCommand(state, { type: 'passBreak', playerId: 'p-alice' }), 'noPlusThreeOpen');
  });

  it('never publishes who is holding a breaker', () => {
    const state = makeState({
      hands: { 'p-alice': cards('plusThree', 'blue:3'), 'p-bob': cards('red:1', 'breakPlusThree') },
      discardPile: cards('red:9'),
    });
    const open = expectOk(play(state, 'p-alice', 'plusThree')).state;
    expect(open.plusThree?.awaiting).toEqual(['p-bob']);
    // The host knows; the table is only told that a +3 is waiting.
    expect(toPublicGameState(open).plusThree).toEqual({ playerId: 'p-alice' });
  });
});
