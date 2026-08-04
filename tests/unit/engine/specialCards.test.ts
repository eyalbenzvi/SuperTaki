import { describe, expect, it } from 'vitest';
import { applyCommand, currentPlayer } from '../../../src/features/game/engine/engine.ts';
import { cards, eventTypes, expectOk, makeState, players } from '../helpers/engineFixtures.ts';

function playFirst(
  state: ReturnType<typeof makeState>,
  playerId: string,
  chosenColor?: 'red' | 'blue' | 'green' | 'yellow',
) {
  const cardId = (state.hands[playerId] ?? [])[0]!.id;
  return applyCommand(
    state,
    chosenColor
      ? { type: 'playCard', playerId, cardId, chosenColor }
      : { type: 'playCard', playerId, cardId },
  );
}

describe('stop card', () => {
  it('skips the next player with three players', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('red:stop', 'blue:3'),
        'p-bob': cards('red:1'),
        'p-carol': cards('red:3'),
      },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(playFirst(state, 'p-alice'));
    expect(currentPlayer(next)?.id).toBe('p-carol');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'playerSkipped', 'turnChanged']);
    expect(events.find((event) => event.type === 'playerSkipped')).toMatchObject({ playerId: 'p-bob' });
  });

  it('returns the turn to the same player in a two-player game', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:stop', 'blue:3'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    const { state: next } = expectOk(playFirst(state, 'p-alice'));
    expect(currentPlayer(next)?.id).toBe('p-alice');
  });

  it('respects a reversed direction', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      direction: -1,
      hands: {
        'p-alice': cards('red:stop', 'blue:3'),
        'p-bob': cards('red:1'),
        'p-carol': cards('red:3'),
      },
      discardPile: cards('red:9'),
    });
    const { state: next } = expectOk(playFirst(state, 'p-alice'));
    // Carol (index 2) is skipped, so Bob (index 1) plays.
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });
});

describe('plus card', () => {
  it('keeps the turn and marks an outstanding play', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:plus', 'red:4'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(playFirst(state, 'p-alice'));
    expect(next.pendingPlus).toBe(true);
    expect(currentPlayer(next)?.id).toBe('p-alice');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'extraTurn']);
  });

  /*
   * The obligation is to *act*, not to play. Paying it from the pile is a choice
   * the player is allowed to make even holding a legal card, and it ends the turn
   * like any other draw.
   */
  it('lets the owed card be taken from the pile instead, even holding a legal one', () => {
    const state = makeState({
      pendingPlus: true,
      hands: { 'p-alice': cards('red:4'), 'p-bob': cards('red:1') },
      discardPile: cards('red:plus'),
      activeColor: 'red',
      drawPile: cards('yellow:3'),
    });
    const { state: next } = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }));
    expect(next.hands['p-alice']).toHaveLength(2);
    expect(next.pendingPlus).toBe(false);
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });

  it('takes one card for the obligation, never two', () => {
    const state = makeState({
      pendingPlus: true,
      hands: { 'p-alice': cards('red:4'), 'p-bob': cards('red:1') },
      discardPile: cards('red:plus'),
      activeColor: 'red',
      drawPile: cards('yellow:3', 'yellow:4', 'yellow:5'),
    });
    const { state: next } = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }));
    expect(next.drawPile).toHaveLength(2);
  });

  it('allows drawing when nothing legal is held and then ends the turn', () => {
    const state = makeState({
      pendingPlus: true,
      hands: { 'p-alice': cards('blue:4'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
      activeColor: 'red',
      drawPile: cards('yellow:3'),
    });
    const { state: next } = expectOk(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }));
    expect(next.pendingPlus).toBe(false);
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });

  it('clears the obligation when the extra card is played', () => {
    const state = makeState({
      pendingPlus: true,
      hands: { 'p-alice': cards('red:4', 'red:5'), 'p-bob': cards('red:1') },
      discardPile: cards('red:plus'),
      activeColor: 'red',
    });
    const { state: next } = expectOk(playFirst(state, 'p-alice'));
    expect(next.pendingPlus).toBe(false);
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });

  it('chains when the extra card is another plus', () => {
    const state = makeState({
      pendingPlus: true,
      hands: { 'p-alice': cards('red:plus', 'red:5'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
      activeColor: 'red',
    });
    const { state: next } = expectOk(playFirst(state, 'p-alice'));
    expect(next.pendingPlus).toBe(true);
    expect(currentPlayer(next)?.id).toBe('p-alice');
  });
});

describe('change direction card', () => {
  it('reverses the order with three players', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('red:direction', 'blue:3'),
        'p-bob': cards('red:1'),
        'p-carol': cards('red:3'),
      },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(playFirst(state, 'p-alice'));
    expect(next.direction).toBe(-1);
    expect(currentPlayer(next)?.id).toBe('p-carol');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'directionChanged', 'turnChanged']);
  });

  it('reverses again back to clockwise', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      direction: -1,
      hands: {
        'p-alice': cards('red:direction', 'blue:3'),
        'p-bob': cards('red:1'),
        'p-carol': cards('red:3'),
      },
      discardPile: cards('red:9'),
    });
    const { state: next } = expectOk(playFirst(state, 'p-alice'));
    expect(next.direction).toBe(1);
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });

  it('passes the turn to the opponent in a two-player game', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:direction', 'blue:3'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    const { state: next } = expectOk(playFirst(state, 'p-alice'));
    expect(next.direction).toBe(-1);
    expect(currentPlayer(next)?.id).toBe('p-bob');
  });
});

describe('colour change wild card', () => {
  it('sets the active colour and passes the turn', () => {
    const state = makeState({
      hands: { 'p-alice': cards('colorChange', 'blue:3'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(playFirst(state, 'p-alice', 'green'));
    expect(next.activeColor).toBe('green');
    expect(next.takiMode).toBeNull();
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'colorChosen', 'turnChanged']);
  });

  it('is playable on any top card', () => {
    const state = makeState({
      hands: { 'p-alice': cards('colorChange', 'blue:3'), 'p-bob': cards('red:1') },
      discardPile: cards('yellow:stop'),
      activeColor: 'yellow',
    });
    expectOk(playFirst(state, 'p-alice', 'blue'));
  });
});
