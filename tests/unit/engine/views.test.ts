import { describe, expect, it } from 'vitest';
import {
  computeStandings,
  playContextFromPublic,
  toPrivateHandView,
  toPublicGameState,
} from '../../../src/features/game/engine/views.ts';
import { cards, makeState, players } from '../helpers/engineFixtures.ts';

describe('public game state', () => {
  const state = makeState({
    players: players('Alice', 'Bob', 'Carol'),
    hands: {
      'p-alice': cards('red:1', 'red:3'),
      'p-bob': cards('blue:1'),
      'p-carol': cards('green:1', 'green:3', 'green:3'),
    },
    discardPile: cards('red:8', 'red:9'),
    drawPile: cards('yellow:1', 'yellow:3'),
    activeColor: 'red',
  });

  it('exposes only card counts, never card identities', () => {
    const view = toPublicGameState(state);
    const serialised = JSON.stringify(view);
    for (const card of state.hands['p-alice'] ?? []) {
      expect(serialised).not.toContain(card.id);
    }
    for (const card of state.drawPile) {
      expect(serialised).not.toContain(card.id);
    }
    expect(view.players.map((player) => player.cardCount)).toEqual([2, 1, 3]);
  });

  it('exposes the visible discard top and pile sizes', () => {
    const view = toPublicGameState(state);
    expect(view.discardTop?.id).toBe(state.discardPile.at(-1)!.id);
    expect(view.discardCount).toBe(2);
    expect(view.drawPileCount).toBe(2);
  });

  it('reports turn information', () => {
    const view = toPublicGameState(state);
    expect(view.currentPlayerId).toBe('p-alice');
    expect(view.direction).toBe(1);
    expect(view.activeColor).toBe('red');
    expect(view.takiMode).toBeNull();
    expect(view.pendingPlus).toBe(false);
    expect(view.winnerId).toBeNull();
  });

  it('handles an empty discard pile and a missing seat', () => {
    const view = toPublicGameState(makeState({ discardPile: [], currentPlayerIndex: 5 }));
    expect(view.discardTop).toBeNull();
    expect(view.currentPlayerId).toBeNull();
  });

  it('produces the same rule context as the host state', () => {
    const view = toPublicGameState(state);
    expect(playContextFromPublic(view)).toEqual({
      activeColor: 'red',
      topCard: view.discardTop,
      openTakiColor: null,
      takiSwitchOpen: false,
      pendingDraw: 0,
      freePlay: false,
    });
  });

  it('reflects an open taki sequence', () => {
    const view = toPublicGameState(
      makeState({
        takiMode: { color: 'blue', playerId: 'p-alice', cardsPlayed: 2, openedWithSuperTaki: true, takisOnly: false },
      }),
    );
    expect(playContextFromPublic(view).openTakiColor).toBe('blue');
  });
});

describe('private hand view', () => {
  it('returns only the requested hand', () => {
    const state = makeState({
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:1', 'blue:3') },
    });
    const view = toPrivateHandView(state, 'p-bob');
    expect(view.playerId).toBe('p-bob');
    expect(view.version).toBe(state.version);
    expect(view.cards).toHaveLength(2);
  });

  it('returns an empty hand for an unknown player', () => {
    expect(toPrivateHandView(makeState(), 'nobody').cards).toEqual([]);
  });
});

describe('standings', () => {
  it('orders by remaining cards ascending', () => {
    const view = toPublicGameState(
      makeState({
        players: players('Alice', 'Bob', 'Carol'),
        hands: {
          'p-alice': cards('red:1', 'red:3'),
          'p-bob': [],
          'p-carol': cards('green:1', 'green:3', 'green:3'),
        },
      }),
    );
    expect(computeStandings(view)).toEqual([
      { playerId: 'p-bob', name: 'Bob', cardCount: 0, rank: 1 },
      { playerId: 'p-alice', name: 'Alice', cardCount: 2, rank: 2 },
      { playerId: 'p-carol', name: 'Carol', cardCount: 3, rank: 3 },
    ]);
  });

  it('shares a rank for ties', () => {
    const view = toPublicGameState(
      makeState({
        players: players('Alice', 'Bob', 'Carol'),
        hands: {
          'p-alice': cards('red:1'),
          'p-bob': cards('blue:1'),
          'p-carol': [],
        },
      }),
    );
    expect(computeStandings(view).map((row) => row.rank)).toEqual([1, 2, 2]);
  });
});
