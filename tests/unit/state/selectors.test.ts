import { describe, expect, it } from 'vitest';
import {
  activeColor,
  connectedCount,
  currentPlayerName,
  everyoneConnected,
  amCreator,
  isMyTurn,
  isTakiOpenForMe,
  localLobbyPlayer,
  myStairsStep,
  needsColorChoice,
  opponents,
  playableCardIds,
  playerName,
  roundGameMode,
  scoreboard,
  sortHandForDisplay,
  standings,
  tableGameMode,
  winnerName,
} from '../../../src/features/game/state/selectors.ts';
import type { AppState } from '../../../src/features/game/state/store.ts';
import type { Card } from '../../../src/features/game/engine/cards.ts';
import type { PublicGameState } from '../../../src/features/game/engine/views.ts';
import type { LobbySnapshot } from '../../../src/features/game/network/protocol.ts';
import { LAST_CARD_GRACE_MS } from '../../../src/features/game/network/timing.ts';

const red5: Card = { id: 'c1', kind: 'number', color: 'red', value: 5 };
const blue3: Card = { id: 'c2', kind: 'number', color: 'blue', value: 3 };
const wild: Card = { id: 'c3', kind: 'colorChange' };

const lobby: LobbySnapshot = {
  roomCode: '482913',
  creatorPlayerId: 'a',
  maxPlayers: 4,
  phase: 'inGame',
  tableLanguage: 'he',
  players: [
    { id: 'a', name: 'Ann', isCreator: true, health: 'connected', seat: 0 },
    { id: 'b', name: 'Ben', isCreator: false, health: 'disconnected', seat: 1 },
    { id: 'c', name: 'Cat', isCreator: false, health: 'disconnected', seat: 2 },
  ],
  sentAt: 1_700_000_000_000,
  seatGraceMs: 300_000,
  pausedBy: null,
  waitingFor: null,
  waitingReason: null,
  waitingSince: null,
  abandonVotes: [],
  standInEnabled: true,
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
  pendingDraw: 0,
  freePlay: false,
  plusThree: null,
  declaredLastCard: [],
  winnerId: null,
};

function state(patch: Partial<AppState> = {}): AppState {
  return {
    language: 'he',
    theme: 'system',
    sound: true,
    displayName: 'Ben',
    screen: 'game',
    inRoom: true,
    phase: 'connected',
    busy: false,
    roomCode: '482913',
    inviteUrl: null,
    localPlayerId: 'b',
    lobby,
    publicState,
    hand: [red5, blue3, wild],
    feed: [],
    beat: null,
    playAgain: null,
    error: null,
    rejection: null,
    closedReason: null,
    resumable: null,
    pausedBy: null,
    nudge: null,
    caught: null,
    assist: { catchDelayMs: LAST_CARD_GRACE_MS, settings: null },
    actionPending: false,
    leaveIntent: false,
    online: true,
    announcement: null,
    ...patch,
  };
}

describe('identity selectors', () => {
  it('reads the lobby buttons off the room rather than off a local flag', () => {
    // `creatorPlayerId` is the room's answer and it travels in every snapshot, so
    // every screen at the table agrees about who has the buttons.
    expect(amCreator(state({ localPlayerId: 'a' }))).toBe(true);
    expect(amCreator(state())).toBe(false);
    expect(amCreator(state({ lobby: null }))).toBe(false);
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
    const taki = {
      color: 'red' as const,
      playerId: 'b',
      cardsPlayed: 1,
      openedWithSuperTaki: false,
      takisOnly: false,
    };
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
    expect(ann).toMatchObject({ name: 'Ann', isCreator: true, isCurrent: false });
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
    // Two states, not three: 'unstable' meant "we are inferring and unsure", and the
    // room is told when a socket closes rather than inferring.
    expect(connectedCount(state())).toBe(1);
    expect(everyoneConnected(state())).toBe(false);
    const allGood: LobbySnapshot = {
      ...lobby,
      players: lobby.players.map((player) => ({ ...player, health: 'connected' as const })),
    };
    expect(everyoneConnected(state({ lobby: allGood }))).toBe(true);
    expect(everyoneConnected(state({ lobby: null }))).toBe(true);
  });
});

describe('hand display order', () => {
  it('groups the hand by colour and orders each group, colourless last', () => {
    const hand: Card[] = [
      { id: 'a', kind: 'colorChange' },
      { id: 'b', kind: 'number', color: 'blue', value: 3 },
      { id: 'c', kind: 'number', color: 'red', value: 9 },
      { id: 'd', kind: 'stop', color: 'red' },
      { id: 'e', kind: 'number', color: 'red', value: 1 },
      { id: 'f', kind: 'number', color: 'yellow', value: 5 },
      { id: 'g', kind: 'king' },
    ];
    expect(sortHandForDisplay(hand).map((card) => card.id)).toEqual(['e', 'c', 'd', 'f', 'b', 'a', 'g']);
  });

  it('leaves the callers array untouched', () => {
    const hand: Card[] = [
      { id: 'b', kind: 'number', color: 'blue', value: 3 },
      { id: 'a', kind: 'number', color: 'red', value: 1 },
    ];
    sortHandForDisplay(hand);
    expect(hand.map((card) => card.id)).toEqual(['b', 'a']);
  });

  it('is stable, so cards do not swap places between renders', () => {
    const hand: Card[] = [
      { id: 'x', kind: 'number', color: 'red', value: 4 },
      { id: 'y', kind: 'number', color: 'red', value: 4 },
    ];
    expect(sortHandForDisplay(hand).map((card) => card.id)).toEqual(['x', 'y']);
    expect(sortHandForDisplay(sortHandForDisplay(hand)).map((card) => card.id)).toEqual(['x', 'y']);
  });
});

/**
 * The room's running score, and the round's mode.
 *
 * Both are read from the place that owns them, and that distinction is the point of
 * these tests: the score belongs to the room and travels in the lobby, while the
 * mode a round is *being played under* belongs to the round and travels in the game
 * state. Reading either from the other is wrong in a way that only shows up between
 * rounds, which is exactly when nobody is looking.
 */
describe('mode and score selectors', () => {
  it('reads the round’s mode from the round, and the table’s from the lobby', () => {
    // A table that switched to stairs for the *next* deal, while a classic round is
    // still on screen. The two answers must not be the same one.
    const between = state({
      lobby: { ...lobby, gameMode: 'stairs' },
      publicState: { ...publicState, mode: 'classic' },
    });
    expect(roundGameMode(between)).toBe('classic');
    expect(tableGameMode(between)).toBe('stairs');

    // And a peer that says nothing means the game as it always was.
    expect(roundGameMode(state())).toBe('classic');
    expect(tableGameMode(state())).toBe('classic');
  });

  it('answers with a step only while a staircase is being played', () => {
    expect(myStairsStep(state())).toBeNull();
    const stairs = state({
      publicState: {
        ...publicState,
        mode: 'stairs',
        players: [
          { id: 'a', name: 'Ann', cardCount: 3, stairsStep: 2 },
          { id: 'b', name: 'Ben', cardCount: 2, stairsStep: 5 },
          { id: 'c', name: 'Cat', cardCount: 7, stairsStep: 0 },
        ],
      },
    });
    // The local seat is Ben's.
    expect(myStairsStep(stairs)).toBe(5);
    expect(opponents(stairs).map((seat) => seat.stairsStep)).toEqual([0, 2]);
    expect(opponents(state()).map((seat) => seat.stairsStep)).toEqual([null, null]);
  });

  it('ranks the score by wins, sharing a place on a tie', () => {
    const scored = state({
      lobby: {
        ...lobby,
        players: [
          { ...lobby.players[0]!, wins: 1 },
          { ...lobby.players[1]!, wins: 3 },
          { ...lobby.players[2]!, wins: 1 },
        ],
      },
    });
    expect(scoreboard(scored)).toEqual([
      { playerId: 'b', name: 'Ben', wins: 3, rank: 1 },
      { playerId: 'a', name: 'Ann', wins: 1, rank: 2 },
      { playerId: 'c', name: 'Cat', wins: 1, rank: 2 },
    ]);
  });

  it('has nothing to say until a round has been won', () => {
    // A first round, and a snapshot from a room with no score at all: both are
    // "nothing to show" rather than a column of noughts.
    expect(scoreboard(state())).toEqual([]);
    expect(scoreboard(state({ lobby: { ...lobby, players: [{ ...lobby.players[0]!, wins: 0 }] } }))).toEqual(
      [],
    );
  });
});
