import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  currentPlayer,
  playContextFromState,
  topCard,
} from '../../../src/features/game/engine/engine.ts';
import {
  cards,
  eventTypes,
  expectOk,
  expectRejected,
  makeState,
  players,
} from '../helpers/engineFixtures.ts';

describe('command validation', () => {
  it('rejects commands once the game is finished', () => {
    const state = makeState({ phase: 'finished', winnerId: 'p-alice' });
    expectRejected(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }), 'gameFinished');
  });

  it('rejects unknown players', () => {
    const state = makeState();
    expectRejected(applyCommand(state, { type: 'drawCard', playerId: 'ghost' }), 'unknownPlayer');
  });

  it('rejects players acting out of turn', () => {
    const state = makeState();
    expectRejected(applyCommand(state, { type: 'drawCard', playerId: 'p-bob' }), 'notYourTurn');
  });

  it('rejects cards that are not in hand', () => {
    const state = makeState();
    expectRejected(
      applyCommand(state, { type: 'playCard', playerId: 'p-alice', cardId: 'nope' }),
      'cardNotInHand',
    );
  });

  it('rejects illegal cards', () => {
    const state = makeState({
      hands: { 'p-alice': cards('blue:2'), 'p-bob': cards('red:1') },
      discardPile: cards('red:5'),
    });
    const cardId = (state.hands['p-alice'] ?? [])[0]!.id;
    expectRejected(applyCommand(state, { type: 'playCard', playerId: 'p-alice', cardId }), 'illegalCard');
  });

  it('requires a colour for wild cards', () => {
    const state = makeState({ hands: { 'p-alice': cards('colorChange'), 'p-bob': cards('red:1') } });
    const cardId = (state.hands['p-alice'] ?? [])[0]!.id;
    expectRejected(applyCommand(state, { type: 'playCard', playerId: 'p-alice', cardId }), 'colorRequired');
  });

  it('rejects an invalid colour for wild cards', () => {
    const state = makeState({ hands: { 'p-alice': cards('colorChange'), 'p-bob': cards('red:1') } });
    const cardId = (state.hands['p-alice'] ?? [])[0]!.id;
    expectRejected(
      applyCommand(state, {
        type: 'playCard',
        playerId: 'p-alice',
        cardId,
        chosenColor: 'purple' as never,
      }),
      'colorNotAllowed',
    );
  });

  it('rejects a colour choice for coloured cards', () => {
    const state = makeState({ hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1') } });
    const cardId = (state.hands['p-alice'] ?? [])[0]!.id;
    expectRejected(
      applyCommand(state, { type: 'playCard', playerId: 'p-alice', cardId, chosenColor: 'blue' }),
      'colorNotAllowed',
    );
  });

  it('never mutates the input state', () => {
    const state = makeState({ hands: { 'p-alice': cards('red:3', 'blue:8'), 'p-bob': cards('red:1') } });
    const before = JSON.stringify(state);
    const cardId = (state.hands['p-alice'] ?? [])[0]!.id;
    expectOk(applyCommand(state, { type: 'playCard', playerId: 'p-alice', cardId }));
    expect(JSON.stringify(state)).toBe(before);
  });

  it('increments the version on every accepted command', () => {
    const state = makeState({ hands: { 'p-alice': cards('red:3', 'blue:8'), 'p-bob': cards('red:1') } });
    const next = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' })).state;
    expect(next.version).toBe(state.version + 1);
  });
});

describe('playing a plain number card', () => {
  it('moves the card to the discard pile and passes the turn', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3', 'blue:8'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    const cardId = (state.hands['p-alice'] ?? [])[0]!.id;
    const { state: next, events } = expectOk(
      applyCommand(state, { type: 'playCard', playerId: 'p-alice', cardId }),
    );

    expect(next.hands['p-alice']).toHaveLength(1);
    expect(topCard(next)?.id).toBe(cardId);
    expect(next.activeColor).toBe('red');
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'turnChanged']);
  });
});

describe('drawing', () => {
  it('adds one card and ends the turn', () => {
    const state = makeState({
      hands: { 'p-alice': cards('blue:2'), 'p-bob': cards('red:1') },
      drawPile: cards('green:7', 'green:8'),
    });
    const { state: next, events } = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }));

    expect(next.hands['p-alice']).toHaveLength(2);
    expect(next.drawPile).toHaveLength(1);
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expect(eventTypes(events)).toEqual(['cardDrawn', 'turnChanged']);
  });

  it('does not let the drawn card be played in the same turn', () => {
    const state = makeState({
      hands: { 'p-alice': cards('blue:2'), 'p-bob': cards('red:1') },
      drawPile: cards('red:7'),
    });
    const next = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' })).state;
    const drawn = (next.hands['p-alice'] ?? []).at(-1)!;
    expectRejected(
      applyCommand(next, { type: 'playCard', playerId: 'p-alice', cardId: drawn.id }),
      'notYourTurn',
    );
  });
});

describe('helpers', () => {
  it('reports the current player and null for an empty table', () => {
    const state = makeState({ players: players('Alice', 'Bob'), currentPlayerIndex: 1 });
    expect(currentPlayer(state)?.name).toBe('Bob');
    expect(currentPlayer({ ...state, currentPlayerIndex: 9 })).toBeNull();
  });

  it('returns null top card for an empty discard pile', () => {
    expect(topCard({ discardPile: [] })).toBeNull();
  });

  it('derives a play context from state', () => {
    const state = makeState({ discardPile: cards('blue:4'), activeColor: 'blue' });
    expect(playContextFromState(state)).toEqual({
      activeColor: 'blue',
      topCard: state.discardPile[0],
      openTakiColor: null,
    });
  });
});
