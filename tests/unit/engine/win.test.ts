import { describe, expect, it } from 'vitest';
import { LAST_CARD_PENALTY } from '../../../src/features/game/engine/cards.ts';
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
   * The one card a round cannot be won on.
   *
   * A Plus says "play again", and a player with nothing left cannot. So the Plus is
   * paid the way any Plus may be paid — from the pile — and its owner ends the turn
   * on the single card they have just drawn, one move further from the round than
   * they were when they put it down.
   */
  it('does not win on a plus card, but takes one from the pile', () => {
    const pile = cards('green:4');
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
      drawPile: pile,
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('playing');
    expect(next.winnerId).toBeNull();
    expect(next.hands['p-alice']).toEqual(pile);
    // The extra turn is not granted either: the pile paid for it, and paying from
    // the pile ends a turn.
    expect(next.pendingPlus).toBe(false);
    expect(next.currentPlayerIndex).toBe(1);
    expect(eventTypes(events)).toEqual(['cardPlayed', 'plusRefilled', 'cardDrawn', 'turnChanged']);
  });

  /*
   * The declaration went down with the Plus. What comes back off the pile is a card
   * nobody has claimed, so its owner is exposed again until they shout for it — which
   * is the whole substance of "a Plus is not a way out of a last card".
   */
  it('leaves the refilled hand undeclared and catchable', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:9'),
      drawPile: cards('green:4', 'green:5', 'green:6', 'green:7', 'green:8'),
    });
    const { state: next } = expectOk(playOnly(state, 'p-alice'));
    expect(next.declaredLastCard).toEqual([]);
    const caught = expectOk(
      applyCommand(next, { type: 'catchLastCard', playerId: 'p-bob', targetId: 'p-alice' }),
    ).state;
    expect(caught.hands['p-alice']).toHaveLength(1 + LAST_CARD_PENALTY);
  });

  /*
   * The exception the rule cannot avoid: nothing in the pile and nothing in the
   * discard to shuffle back into it. Nothing can be taken, so the hand really is
   * empty, and a round that cannot go on ends where it stands.
   */
  it('wins on a plus card when there is nothing left to take', () => {
    const state = makeState({
      ...declared,
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      // The card being played becomes the only discard, so there is nothing under
      // it to recycle — the one state in which a Plus can leave a hand empty.
      discardPile: [],
      activeColor: 'red',
      drawPile: [],
    });
    const { state: next, events } = expectOk(playOnly(state, 'p-alice'));
    expect(next.phase).toBe('finished');
    expect(next.winnerId).toBe('p-alice');
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

  it('refills inside an open taki sequence without closing it', () => {
    const state = makeState({
      ...declared,
      takiMode: {
        color: 'red',
        playerId: 'p-alice',
        cardsPlayed: 1,
        openedWithSuperTaki: false,
        takisOnly: false,
      },
      hands: { 'p-alice': cards('red:plus'), 'p-bob': cards('red:1', 'blue:3') },
      discardPile: cards('red:taki'),
      activeColor: 'red',
      drawPile: cards('green:4'),
    });
    const { state: next } = expectOk(playOnly(state, 'p-alice'));
    // The sequence is hers and still open, so the turn has not moved — the Plus
    // takes its card and the run carries on.
    expect(next.phase).toBe('playing');
    expect(next.takiMode?.cardsPlayed).toBe(2);
    expect(next.currentPlayerIndex).toBe(0);
    expect(next.hands['p-alice']).toHaveLength(1);
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
