import { describe, expect, it } from 'vitest';
import {
  activeColor,
  connectedCount,
  currentPlayerName,
  everyoneConnected,
  isHost,
  isMyTurn,
  isTakiOpenForMe,
  localLobbyPlayer,
  needsColorChoice,
  opponents,
  playableCardIds,
  playerName,
  standings,
  winnerName,
} from '../../../src/features/game/state/selectors.ts';
import type { AppState } from '../../../src/features/game/state/store.ts';
import type { Card } from '../../../src/features/game/engine/cards.ts';
import type { PublicGameState } from '../../../src/features/game/engine/views.ts';
import type { LobbySnapshot } from '../../../src/features/game/network/protocol.ts';

const red5: Card = { id: 'c1', kind: 'number', color: 'red', value: 5 };
const blue2: Card = { id: 'c2', kind: 'number', color: 'blue', value: 2 };
const wild: Card = { id: 'c3', kind: 'colorChange' };

const lobby: LobbySnapshot = {
  roomCode: 'TIGER-MANGO-42',
  hostPeerId: 'crush-tiger-mango-42',
  hostPlayerId: 'a',
  maxPlayers: 4,
  phase: 'inGame',
  tableLanguage: 'he',
  players: [
    { id: 'a', name: 'Ann', isHost: true, health: 'connected', seat: 0 },
    { id: 'b', name: 'Ben', isHost: false, health: 'unstable', seat: 1 },
    { id: 'c', name: 'Cat', isHost: false, health: 'disconnected', seat: 2 },
  ],
};

const publicState: PublicGameState = {
  version: 5,
  phase: 'playing',
  players: [
    { id: 'a', name: 'Ann', cardCount: 3 },
    { id: 'b', name: 'Ben', cardCount: 2 },
    { id: 'c', name: 'Cat', cardCount: 7 },
  ],
  drawPileCount: 20,
  discardTop: red5,
  discardCount: 4,
  activeColor: 'red',
  direction: 1,
  currentPlayerId: 'b',
  takiMode: null,
  pendingPlus: false,
  winnerId: null,
};

function state(patch: Partial<AppState> = {}): AppState {
  return {
    language: 'he',
    theme: 'system',
    displayName: 'Ben',
    screen: 'game',
    screenBeforeRules: 'home',
    role: 'client',
    phase: 'connected',
    busy: false,
    roomCode: 'TIGER-MANGO-42',
    hostPeerId: 'crush-tiger-mango-42',
    inviteUrl: null,
    localPlayerId: 'b',
    lobby,
    publicState,
    hand: [red5, blue2, wild],
    feed: [],
    playAgain: null,
    error: null,
    rejection: null,
    closedReason: null,
    resumable: null,
    ...patch,
  };
}

describe('role and identity selectors', () => {
  it('reports the host role', () => {
    expect(isHost(state({ role: 'host' }))).toBe(true);
    expect(isHost(state())).toBe(false);
  });

  it('finds the local lobby entry', () => {
    expect(localLobbyPlayer(state())?.name).toBe('Ben');
    expect(localLobbyPlayer(state({ localPlayerId: 'zz' }))).toBeNull();
    expect(localLobbyPlayer(state({ lobby: null }))).toBeNull();
  });

  it('resolves names, falling back to the lobby and then the id', () => {
    expect(playerName(state(), 'a')).toBe('Ann');
    expect(playerName(state({ publicState: null }), 'a')).toBe('Ann');
    expect(playerName(state({ publicState: null, lobby: null }), 'zz')).toBe('zz');
  });
});

describe('turn selectors', () => {
  it('knows whose turn it is', () => {
    expect(isMyTurn(state())).toBe(true);
    expect(isMyTurn(state({ localPlayerId: 'a' }))).toBe(false);
    expect(currentPlayerName(state())).toBe('Ben');
  });

  it('is never my turn without a table or after the round ends', () => {
    expect(isMyTurn(state({ publicState: null }))).toBe(false);
    expect(isMyTurn(state({ publicState: { ...publicState, phase: 'finished', winnerId: 'b' } }))).toBe(
      false,
    );
    expect(currentPlayerName(state({ publicState: { ...publicState, currentPlayerId: null } }))).toBeNull();
  });

  it('lists legal cards only on my turn', () => {
    expect(playableCardIds(state())).toEqual(['c1', 'c3']);
    expect(playableCardIds(state({ localPlayerId: 'a' }))).toEqual([]);
    expect(playableCardIds(state({ publicState: null }))).toEqual([]);
  });

  it('flags wild cards as needing a colour', () => {
    expect(needsColorChoice(wild)).toBe(true);
    expect(needsColorChoice(red5)).toBe(false);
  });

  it('reports the active colour', () => {
    expect(activeColor(state())).toBe('red');
    expect(activeColor(state({ publicState: null }))).toBeNull();
  });

  it('knows whether the open sequence is mine', () => {
    const taki = { color: 'red' as const, playerId: 'b', cardsPlayed: 1, openedWithSuperTaki: false };
    expect(isTakiOpenForMe(state({ publicState: { ...publicState, takiMode: taki } }))).toBe(true);
    expect(
      isTakiOpenForMe(state({ publicState: { ...publicState, takiMode: { ...taki, playerId: 'a' } } })),
    ).toBe(false);
    expect(isTakiOpenForMe(state())).toBe(false);
  });
});

describe('opponent ordering', () => {
  it('lists opponents in play order after the local player', () => {
    expect(opponents(state()).map((player) => player.name)).toEqual(['Cat', 'Ann']);
    expect(opponents(state({ localPlayerId: 'a' })).map((player) => player.name)).toEqual(['Ben', 'Cat']);
  });

  it('carries connection health and the current-turn flag', () => {
    const [cat, ann] = opponents(state());
    expect(cat).toMatchObject({ name: 'Cat', cardCount: 7, health: 'disconnected', isCurrent: false });
    expect(ann).toMatchObject({ name: 'Ann', isHost: true, isCurrent: false });
    expect(opponents(state({ localPlayerId: 'a' }))[0]).toMatchObject({ isCurrent: true });
  });

  it('assumes connected when the lobby is unknown', () => {
    expect(opponents(state({ lobby: null }))[0]?.health).toBe('connected');
  });

  it('returns nothing without a table', () => {
    expect(opponents(state({ publicState: null }))).toEqual([]);
  });

  it('shows the whole table in seat order when the viewer holds no seat', () => {
    expect(opponents(state({ localPlayerId: 'zz' })).map((player) => player.name)).toEqual([
      'Ann',
      'Ben',
      'Cat',
    ]);
  });
});

describe('standings and health', () => {
  it('sorts the final table by fewest cards', () => {
    const rows = standings(state({ publicState: { ...publicState, phase: 'finished', winnerId: 'b' } }));
    expect(rows.map((row) => row.name)).toEqual(['Ben', 'Ann', 'Cat']);
    expect(standings(state({ publicState: null }))).toEqual([]);
  });

  it('names the winner', () => {
    expect(winnerName(state({ publicState: { ...publicState, winnerId: 'a' } }))).toBe('Ann');
    expect(winnerName(state())).toBeNull();
  });

  it('counts connected players', () => {
    expect(connectedCount(state())).toBe(2);
    expect(everyoneConnected(state())).toBe(false);
    const allGood: LobbySnapshot = {
      ...lobby,
      players: lobby.players.map((player) => ({ ...player, health: 'connected' as const })),
    };
    expect(everyoneConnected(state({ lobby: allGood }))).toBe(true);
    expect(everyoneConnected(state({ lobby: null }))).toBe(true);
  });
});
