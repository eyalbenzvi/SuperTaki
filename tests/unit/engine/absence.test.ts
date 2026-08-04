import { describe, expect, it } from 'vitest';
import { activePlayers, applyCommand, currentPlayer } from '../../../src/features/game/engine/engine.ts';
import type { GameState } from '../../../src/features/game/engine/state.ts';
import {
  cards,
  eventTypes,
  expectOk,
  expectRejected,
  makeState,
  players,
} from '../helpers/engineFixtures.ts';

/**
 * The rules for a player who is not there.
 *
 * Two properties are asserted throughout, because they are the ones whose failure
 * is unrecoverable rather than merely annoying:
 *
 * - **the table never stops** — after any absence transition somebody live is on
 *   turn, or the round is over;
 * - **cards are conserved** — a skip or a departure never creates or destroys a
 *   card, so the draw pile count on screen always means what it says.
 */

function totalCards(state: GameState): number {
  const inHands = Object.values(state.hands).reduce((sum, hand) => sum + hand.length, 0);
  return inHands + state.drawPile.length + state.discardPile.length;
}

function expectTableMoves(state: GameState): void {
  if (state.phase === 'finished') {
    return;
  }
  if (state.plusThree !== null) {
    // A breaker window is a legitimate pause, but only if somebody live can end it.
    expect(state.plusThree.awaiting.length).toBeGreaterThan(0);
    return;
  }
  const onTurn = currentPlayer(state);
  expect(onTurn, 'somebody must be on turn').not.toBeNull();
  expect(onTurn?.left).not.toBe(true);
}

describe('skipping the turn of a player who is away', () => {
  it('costs them nothing on an ordinary turn', () => {
    const state = makeState({
      players: players('Alice', 'Bob'),
      hands: { 'p-alice': cards('red:1', 'red:3'), 'p-bob': cards('blue:5') },
      discardPile: cards('red:9'),
    });
    const before = state.hands['p-alice']?.length ?? 0;
    const { state: next, events } = expectOk(applyCommand(state, { type: 'skipTurn', playerId: 'p-alice' }));

    // A disconnect is not a decision. Charging a card per orbit would leave a
    // returning player several cards down after their seat was faithfully held,
    // which would make holding it meaningless.
    expect(next.hands['p-alice']?.length).toBe(before);
    expect(events.find((event) => event.type === 'turnSkipped')).toMatchObject({
      playerId: 'p-alice',
      drew: 0,
    });
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expect(totalCards(next)).toBe(totalCards(state));
    expectTableMoves(next);
  });

  it('pays an outstanding +2 run in full', () => {
    const state = makeState({
      players: players('Alice', 'Bob'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5') },
      discardPile: cards('red:plusTwo'),
      pendingDraw: 4,
      drawPile: cards('green:1', 'green:3', 'green:4', 'green:5', 'green:6'),
    });
    const { state: next, events } = expectOk(applyCommand(state, { type: 'skipTurn', playerId: 'p-alice' }));

    // The one thing that must not evaporate is a penalty somebody *else*
    // created: voiding it would either destroy cards or dump the run on the next
    // seat, and it would make pulling the plug the cheapest answer to a run.
    expect(next.hands['p-alice']).toHaveLength(5);
    expect(next.pendingDraw).toBe(0);
    expect(events.find((event) => event.type === 'turnSkipped')).toMatchObject({ drew: 4 });
    expect(totalCards(next)).toBe(totalCards(state));
    expectTableMoves(next);
  });

  it("forfeits a King's free turn without a penalty", () => {
    // A King cancels everything and hands its player an unrestricted turn. That
    // turn is a gift; charging a card for an unused gift is a penalty the rules
    // do not contain. This is also the state where a skip built out of `drawCard`
    // would simply be rejected: `freePlay` makes every card playable, so the
    // engine insists a card be played.
    const state = makeState({
      players: players('Alice', 'Bob'),
      hands: { 'p-alice': cards('red:1', 'blue:7'), 'p-bob': cards('blue:5') },
      discardPile: cards('king'),
      pendingPlus: true,
      freePlay: true,
    });
    expectRejected(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }), 'mustPlayAfterPlus');

    const { state: next } = expectOk(applyCommand(state, { type: 'skipTurn', playerId: 'p-alice' }));
    expect(next.hands['p-alice']).toHaveLength(2);
    expect(next.pendingPlus).toBe(false);
    expect(next.freePlay).toBe(false);
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expectTableMoves(next);
  });

  it('forfeits a Plus obligation the player is holding a legal answer to', () => {
    const state = makeState({
      players: players('Alice', 'Bob'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5') },
      discardPile: cards('red:plus'),
      pendingPlus: true,
    });
    // Same trap as the King: the engine refuses to draw here.
    expectRejected(applyCommand(state, { type: 'drawCard', playerId: 'p-alice' }), 'mustPlayAfterPlus');

    const { state: next } = expectOk(applyCommand(state, { type: 'skipTurn', playerId: 'p-alice' }));
    expect(next.hands['p-alice']).toHaveLength(1);
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expectTableMoves(next);
  });

  it('closes an open Taki sequence and does not skip an extra player', () => {
    // `closeTaki` already resolves the last card's effect, and for a number that
    // includes advancing the turn. Adding another advance here would rob an
    // innocent player of their turn — and it would look like a bug in Taki, not
    // in the disconnect handling.
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5'), 'p-carol': cards('green:5') },
      discardPile: cards('red:taki', 'red:4'),
      takiMode: { color: 'red', playerId: 'p-alice', cardsPlayed: 2, openedWithSuperTaki: false },
    });
    const { state: next, events } = expectOk(applyCommand(state, { type: 'skipTurn', playerId: 'p-alice' }));

    expect(next.takiMode).toBeNull();
    expect(eventTypes(events)).toContain('takiClosed');
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expectTableMoves(next);
  });

  it('lets a Stop that ends the sequence skip exactly one player', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5'), 'p-carol': cards('green:5') },
      discardPile: cards('red:taki', 'red:stop'),
      takiMode: { color: 'red', playerId: 'p-alice', cardsPlayed: 2, openedWithSuperTaki: false },
    });
    const { state: next } = expectOk(applyCommand(state, { type: 'skipTurn', playerId: 'p-alice' }));

    // Bob is stopped, so Carol moves. Not Alice again, and not Bob.
    expect(currentPlayer(next)?.id).toBe('p-carol');
    expectTableMoves(next);
  });

  it('finishes the skip when the sequence ended on a Plus', () => {
    // This is the only close that leaves the turn with the absent player, so it
    // is the only one where a second step is needed.
    const state = makeState({
      players: players('Alice', 'Bob'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5') },
      discardPile: cards('red:taki', 'red:plus'),
      takiMode: { color: 'red', playerId: 'p-alice', cardsPlayed: 2, openedWithSuperTaki: false },
    });
    const { state: next, events } = expectOk(applyCommand(state, { type: 'skipTurn', playerId: 'p-alice' }));

    expect(next.pendingPlus).toBe(false);
    expect(currentPlayer(next)?.id).toBe('p-bob');
    expect(eventTypes(events)).toContain('turnSkipped');
    expectTableMoves(next);
  });

  it('refuses to skip somebody the table is not waiting for', () => {
    const state = makeState({
      players: players('Alice', 'Bob'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5') },
      currentPlayerIndex: 0,
    });
    expectRejected(applyCommand(state, { type: 'skipTurn', playerId: 'p-bob' }), 'nothingToSkip');
  });

  it('draws what it can when the deck runs dry mid-penalty', () => {
    const state = makeState({
      players: players('Alice', 'Bob'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5') },
      discardPile: cards('red:plusTwo'),
      drawPile: cards('green:1'),
      pendingDraw: 4,
    });
    const { state: next, events } = expectOk(applyCommand(state, { type: 'skipTurn', playerId: 'p-alice' }));

    expect(eventTypes(events)).toContain('drawPileExhausted');
    expect(next.pendingDraw).toBe(0);
    expect(totalCards(next)).toBe(totalCards(state));
    expectTableMoves(next);
  });
});

describe('a breaker window with an absent seat', () => {
  it('settles when the absent seat declines on their behalf', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('red:1'),
        'p-bob': cards('breakPlusThree'),
        'p-carol': cards('green:5'),
      },
      discardPile: cards('red:plusThree'),
      plusThree: { playerId: 'p-alice', awaiting: ['p-bob'] },
      drawPile: cards('green:1', 'green:3', 'green:4', 'green:5', 'green:6', 'green:7'),
    });
    // While a +3 is open, the seat on turn is the player who *played* it — so
    // nothing keyed on "it is the absent player's turn" would ever notice this
    // table is frozen. Declining for them is the only way out.
    const { state: next, events } = expectOk(applyCommand(state, { type: 'passBreak', playerId: 'p-bob' }));

    expect(next.plusThree).toBeNull();
    // An all-decline is exactly what a present player choosing to pass produces,
    // and — importantly — no event names who was holding a breaker. That is
    // information the rules promise never to publish.
    expect(eventTypes(events)).not.toContain('plusThreeBroken');
    expect(totalCards(next)).toBe(totalCards(state));
    expectTableMoves(next);
  });
});

describe('a player who leaves the round', () => {
  it('keeps their seat, their cards and their place in the standings', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5', 'blue:7'), 'p-carol': cards('green:5') },
      currentPlayerIndex: 0,
    });
    const { state: next, events } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-bob' }));

    expect(next.players).toHaveLength(3);
    expect(next.players.find((player) => player.id === 'p-bob')?.left).toBe(true);
    expect(next.hands['p-bob']).toHaveLength(2);
    expect(activePlayers(next)).toHaveLength(2);
    expect(eventTypes(events)).toContain('playerLeft');
    // No reshuffle, no random numbers consumed, no draw-pile jump to explain.
    expect(next.rng).toEqual(state.rng);
    expect(totalCards(next)).toBe(totalCards(state));
  });

  it('steps over them when the turn comes round', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: { 'p-alice': cards('red:1', 'red:3'), 'p-bob': cards('blue:5'), 'p-carol': cards('green:5') },
      currentPlayerIndex: 0,
    });
    const { state: left } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-bob' }));
    const { state: next } = expectOk(applyCommand(left, { type: 'skipTurn', playerId: 'p-alice' }));

    expect(currentPlayer(next)?.id).toBe('p-carol');
    expectTableMoves(next);
  });

  it('does not shift the turn onto the wrong player when an earlier seat goes', () => {
    // The bug this pins: `currentPlayerIndex` is an index. Splicing a seat that
    // sits *before* it silently moves the turn to somebody else — which is why
    // seats are marked rather than removed.
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol', 'Dave'),
      hands: {
        'p-alice': cards('red:1'),
        'p-bob': cards('blue:5'),
        'p-carol': cards('green:5'),
        'p-dave': cards('yellow:5'),
      },
      currentPlayerIndex: 2,
      direction: -1,
    });
    const { state: next } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-bob' }));

    expect(currentPlayer(next)?.id).toBe('p-carol');
    expectTableMoves(next);
  });

  it('moves the turn on when the player on turn is the one leaving', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5'), 'p-carol': cards('green:5') },
      currentPlayerIndex: 1,
      pendingDraw: 4,
    });
    const { state: next } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-bob' }));

    expect(currentPlayer(next)?.id).toBe('p-carol');
    // A penalty inherited from a seat that no longer exists is not passed on to
    // an innocent player — unlike a skip, where the player is expected back.
    expect(next.pendingDraw).toBe(0);
    expectTableMoves(next);
  });

  it('releases a Taki sequence they owned, which would otherwise deadlock for ever', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5'), 'p-carol': cards('green:5') },
      discardPile: cards('red:taki'),
      takiMode: { color: 'red', playerId: 'p-bob', cardsPlayed: 1, openedWithSuperTaki: false },
      currentPlayerIndex: 1,
    });
    const { state: next } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-bob' }));

    // Only its owner can close a sequence and nobody may draw while one is open,
    // so leaving it behind is a permanent freeze for the whole table.
    expect(next.takiMode).toBeNull();
    expectTableMoves(next);
  });

  it('releases a breaker window that was waiting on them', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('red:1'),
        'p-bob': cards('breakPlusThree'),
        'p-carol': cards('green:5'),
      },
      discardPile: cards('red:plusThree'),
      plusThree: { playerId: 'p-alice', awaiting: ['p-bob'] },
      drawPile: cards('green:1', 'green:3', 'green:4', 'green:5', 'green:6', 'green:7'),
    });
    const { state: next } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-bob' }));

    // An `awaiting` entry naming somebody who has gone can never empty, and
    // every command from every seat is refused while one is open.
    expect(next.plusThree).toBeNull();
    expectTableMoves(next);
  });

  it('cancels a +3 whose author has left rather than charging the table', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('red:1'),
        'p-bob': cards('breakPlusThree'),
        'p-carol': cards('green:5'),
      },
      discardPile: cards('red:plusThree'),
      plusThree: { playerId: 'p-alice', awaiting: ['p-bob'] },
    });
    const { state: next } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-alice' }));

    expect(next.plusThree).toBeNull();
    expect(next.hands['p-carol']).toHaveLength(1);
    expectTableMoves(next);
  });

  it('ends the round with no winner when too few players are left', () => {
    const state = makeState({
      players: players('Alice', 'Bob'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5') },
    });
    const { state: next, events } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-bob' }));

    expect(next.phase).toBe('finished');
    // Never a win. The health that gates a removal is measured by the host, so
    // "last player standing wins" would let a two-player host award themselves
    // the round for a twenty-second blip.
    expect(next.winnerId).toBeNull();
    expect(next.endReason).toBe('abandoned');
    expect(eventTypes(events)).toContain('roundAbandoned');
  });

  it('cannot be caught on last card once they have gone', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5'), 'p-carol': cards('green:5') },
    });
    const { state: left } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-bob' }));

    expectRejected(
      applyCommand(left, { type: 'catchLastCard', playerId: 'p-alice', targetId: 'p-bob' }),
      'nothingToCatch',
    );
  });

  it('cannot act again', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5'), 'p-carol': cards('green:5') },
      currentPlayerIndex: 1,
    });
    const { state: left } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-bob' }));

    expectRejected(applyCommand(left, { type: 'drawCard', playerId: 'p-bob' }), 'alreadyLeft');
    expectRejected(applyCommand(left, { type: 'leaveGame', playerId: 'p-bob' }), 'alreadyLeft');
  });

  it('is stepped over by a Stop rather than wasting the card', () => {
    const state = makeState({
      players: players('Alice', 'Bob', 'Carol'),
      hands: {
        'p-alice': cards('red:stop', 'red:3'),
        'p-bob': cards('blue:5'),
        'p-carol': cards('green:5'),
      },
      discardPile: cards('red:9'),
    });
    const { state: left } = expectOk(applyCommand(state, { type: 'leaveGame', playerId: 'p-bob' }));
    const cardId = (left.hands['p-alice'] ?? [])[0]!.id;
    const { state: next, events } = expectOk(
      applyCommand(left, { type: 'playCard', playerId: 'p-alice', cardId }),
    );

    // With Bob gone the Stop has to land on Carol, and the turn returns to
    // Alice. Spending it on an empty seat would rob Carol of nothing and grant
    // Alice nothing.
    expect(events.find((event) => event.type === 'playerSkipped')).toMatchObject({ playerId: 'p-carol' });
    expect(currentPlayer(next)?.id).toBe('p-alice');
    expectTableMoves(next);
  });
});

describe('the turn counter', () => {
  it('moves only when the turn does', () => {
    const state = makeState({
      players: players('Alice', 'Bob'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5') },
    });
    // A declaration is legal at any moment and bumps `version` — which is
    // exactly why `version` cannot be used to ask "is my move still current?".
    const { state: declared } = expectOk(applyCommand(state, { type: 'declareLastCard', playerId: 'p-bob' }));
    expect(declared.version).toBe(state.version + 1);
    expect(declared.turnSeq).toBe(state.turnSeq);

    const { state: skipped } = expectOk(applyCommand(declared, { type: 'skipTurn', playerId: 'p-alice' }));
    expect(skipped.turnSeq).toBe(state.turnSeq + 1);
  });
});
