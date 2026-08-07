import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../../src/features/game/engine/engine.ts';
import { cards, eventTypes, expectOk, expectRejected, makeState } from '../helpers/engineFixtures.ts';

function playOnly(state: ReturnType<typeof makeState>, playerId: string, chosenColor?: 'red' | 'blue') {
  const cardId = (state.hands[playerId] ?? [])[0]!.id;
  return applyCommand(
    state,
    chosenColor
      ? { type: 'playCard', playerId, cardId, chosenColor }
      : { type: 'playCard', playerId, cardId },
  );
}

/*
 * Every win below is on a *declared* last card. An undeclared hand of one cannot
 * win at all — it draws the penalty and the round goes on. That half of the rule
 * lives in `lastCard.test.ts`.
 */
const declared = { declaredLastCard: ['p-alice'] } as const;

describe('win detection', () => {
  it('ends the game when the last card is played', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('finished');
    expect(next.winnerId).toBe('p-alice');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'playerWon']);
  });

  it('wins on a plus card without granting an extra turn', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('finished');
    expect(next.pendingPlus).toBe(false);
    expect(eventTypes(events)).toEqual(['cardPlayed', 'playerWon']);
  });

  it('wins on a taki card without leaving the sequence open', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:taki'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
    });
    const { state: next } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('finished');
    expect(next.takiMode).toBeNull();
  });

  it('wins on the final card of an open taki sequence', () => {
    const state = makeState({
      ...declared,
      takiMode: {
        color: 'red',
        playerId: 'p-alice',
        cardsPlayed: 1,
        openedWithSuperTaki: false,
        takisOnly: false,
      },
      hands: { 'p-alice': cards('red:6'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:taki'),
      activeColor: 'red',
    });
    const { state: next } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('finished');
    expect(next.winnerId).toBe('p-alice');
    expect(next.takiMode).toBeNull();
  });

  it('wins on a wild card after choosing a colour', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('colorChange'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
    });
    const { state: next } = expectOk(playOnly(state, 'p-alice', 'blue'));
    expect(next.phase).toBe('finished');
    expect(next.activeColor).toBe('blue');
  });

  it('locks the game after a win', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:3'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
    });
    const finished = expectOk(playOnly(state, 'p-alice')).state;
    expectRejected(applyCommand(finished, { type: 'drawCard', playerId: 'p-bob' }), 'gameFinished');
    expectRejected(applyCommand(finished, { type: 'closeTaki', playerId: 'p-alice' }), 'gameFinished');
    expectRejected(applyCommand(finished, { type: 'declareLastCard', playerId: 'p-bob' }), 'gameFinished');
  });

  it('does not end the game while cards remain', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:3', 'red:4'), 'p-bob': cards('red:1') },
      discardPile: cards('red:9'),
    });
    const { state: next } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('playing');
    expect(next.winnerId).toBeNull();
  });
});
