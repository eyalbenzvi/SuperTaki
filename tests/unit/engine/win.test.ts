import { describe, expect, it } from 'vitest';
import { applyCommand, currentPlayer } from '../../../src/features/game/engine/engine.ts';
import { cards, eventTypes, expectOk, expectRejected, handOf, makeState } from '../helpers/engineFixtures.ts';

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

  it('does not win on a plus card: the hand still owes one, and takes it from the pile', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5'),
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('playing');
    expect(next.winnerId).toBeNull();
    // The card owed by the Plus, drawn because there was nothing left to play it
    // with — and the turn passes, exactly as paying a Plus from the pile always
    // ends it.
    expect(handOf(next, 'p-alice')[0]).toMatchObject({ kind: 'number', color: 'green', value: 4 });
    expect(next.pendingPlus).toBe(false);
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'plusLastCardDrawn', 'cardDrawn', 'turnChanged']);
  });

  it('drops the declaration that went with the plus: the card taken back is a fresh one', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5', 'green:6', 'green:7', 'green:8', 'green:9'),
    });
    const { state: next } = expectOk(playOnly(state, 'p-alice'));
    expect(next.declaredLastCard).toEqual([]);
    // And so the silence is callable, like any other undeclared single card.
    const caught = expectOk(
      applyCommand(next, { type: 'catchLastCard', playerId: 'p-bob', targetId: 'p-alice' }),
    );
    expect(handOf(caught.state, 'p-alice')).toHaveLength(1 + 4);
  });

  it('closes a sequence the plus emptied the hand inside, then draws', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      takiMode: {
        color: 'red',
        playerId: 'p-alice',
        cardsPlayed: 2,
        openedWithSuperTaki: false,
        takisOnly: false,
      },
      discardPile: cards('red:taki', 'red:6'),
      activeColor: 'red',
      drawPile: cards('green:4', 'green:5'),
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('playing');
    // The hand that was feeding the sequence has gone, so the sequence has too.
    expect(next.takiMode).toBeNull();
    expect(handOf(next, 'p-alice')).toHaveLength(1);
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expect(eventTypes(events)).toEqual([
      'cardPlayed',
      'takiClosed',
      'plusLastCardDrawn',
      'cardDrawn',
      'turnChanged',
    ]);
  });

  it('wins on a plus only when there is genuinely nothing left to draw', () => {
    /*
     * Nothing in the pile and nothing under the Plus to recycle: the obligation
     * cannot be paid by anybody, and an empty hand ends the round the way an empty
     * hand always does. A table cannot actually reach this — the opening card alone
     * makes the discard pile recyclable — and the branch exists so that the engine
     * is total rather than conditional on that.
     */
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: [],
      drawPile: [],
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('finished');
    expect(next.winnerId).toBe('p-alice');
    expect(eventTypes(events)).toEqual(['cardPlayed', 'drawPileExhausted', 'playerWon']);
  });

  it('recycles the discard pile to pay for a last plus', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('blue:5', 'green:7', 'red:9'),
      drawPile: [],
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('playing');
    expect(handOf(next, 'p-alice')).toHaveLength(1);
    expect(eventTypes(events)).toContain('drawPileRecycled');
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
