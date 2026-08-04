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

  /*
   * A Plus is the one card that cannot end a round. It owes another card and an
   * empty hand has none, so the debt is paid from the pile and the round goes on —
   * with its owner back on a single card, and back to owing a declaration for it.
   */
  it('does not win on a plus: the card it owes comes from the pile instead', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      drawPile: cards('green:4', 'green:5'),
      discardPile: cards('red:9'),
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('playing');
    expect(next.winnerId).toBeNull();
    expect(next.hands['p-alice']).toHaveLength(1);
    expect(next.pendingPlus).toBe(false);
    // A different card, so the old declaration does not carry over onto it.
    expect(next.declaredLastCard).toEqual([]);
    expect(eventTypes(events)).toEqual(['cardPlayed', 'plusDeniedWin', 'cardDrawn', 'turnChanged']);
    expect(events.find((event) => event.type === 'plusDeniedWin')).toMatchObject({ drew: 1 });
  });

  it('closes a sequence that ended on the plus rather than leaving it open', () => {
    const state = makeState({
      ...declared,
      takiMode: { color: 'red', playerId: 'p-alice', cardsPlayed: 1, openedWithSuperTaki: false },
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      drawPile: cards('green:4'),
      discardPile: cards('red:taki'),
      activeColor: 'red',
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('playing');
    expect(next.takiMode).toBeNull();
    expect(eventTypes(events)).toEqual([
      'cardPlayed',
      'takiClosed',
      'plusDeniedWin',
      'cardDrawn',
      'turnChanged',
    ]);
  });

  /*
   * The one case where a Plus does win: an obligation nothing can pay cannot hold
   * the round open, or the table would sit for ever on a player who is out of cards
   * and out of pile.
   */
  it('wins on a plus after all when there is nothing left to draw', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      // Nothing in the pile, and nothing recyclable either: the Plus itself is the
      // only card the discard pile will hold, and the visible top card stays put.
      drawPile: [],
      discardPile: [],
      activeColor: 'red',
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('finished');
    expect(next.winnerId).toBe('p-alice');
    expect(next.pendingPlus).toBe(false);
    expect(eventTypes(events)).toEqual(['cardPlayed', 'drawPileExhausted', 'playerWon']);
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
      takiMode: { color: 'red', playerId: 'p-alice', cardsPlayed: 1, openedWithSuperTaki: false },
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
