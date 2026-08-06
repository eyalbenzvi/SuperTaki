import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setChannelFactoryForTests, useAppStore } from '../../../src/features/game/state/store.ts';
import { ScriptedRoom, TEST_ROOM, flush } from '../helpers/room.ts';
import type { LobbySnapshot } from '../../../src/features/game/network/protocol.ts';

/**
 * Holding the table for a beat after somebody wins.
 *
 * Written failure-first, because the risk here is not that the hold fails to
 * happen — it is that the hold happens when the player is no longer looking at the
 * table. Every one of these was reachable with the guard this originally had.
 */
type Store = ReturnType<typeof useAppStore.getState>;
const PRISTINE: Store = { ...useAppStore.getState() };
const ME = 'pl_client000';
const THEM = 'pl_host00000';

let room: ScriptedRoom;

beforeEach(() => {
  room = new ScriptedRoom(TEST_ROOM);
  __setChannelFactoryForTests(room.connect);
  useAppStore.setState({ ...PRISTINE }, true);
});

afterEach(() => {
  vi.useRealTimers();
});

function store(): Store {
  return useAppStore.getState();
}

function lobby(phase: 'lobby' | 'inGame' | 'finished'): LobbySnapshot {
  return {
    roomCode: TEST_ROOM,
    creatorPlayerId: THEM,
    maxPlayers: 4,
    phase,
    tableLanguage: 'he',
    players: [
      { id: THEM, name: 'Dana', isCreator: true, health: 'connected' as const, seat: 0 },
      { id: ME, name: 'Bob', isCreator: false, health: 'connected' as const, seat: 1 },
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
}

async function atTheTable(): Promise<ScriptedRoom> {
  // Started, not awaited: `joinRoom` now waits for the room's answer, and in this
  // file the room is scripted — the answer is the next line.
  const joining = store().joinRoom({ name: 'Bob', roomCode: TEST_ROOM });
  await flush();
  room.say('joinAccepted', {
    playerId: ME,
    resumeToken: 'b'.repeat(32),
    displayName: 'Bob',
    lobby: lobby('inGame'),
  });
  await joining;
  await flush();
  expect(store().screen).toBe('game');
  return room;
}

describe('the win hold', () => {
  it('keeps the table up for a moment, then shows the standings', async () => {
    await atTheTable();
    room.say('lobbyState', { lobby: lobby('finished') });
    await flush();

    // Still on the table: the winning card is landing.
    expect(store().screen).toBe('game');
    // But the standings already have their data, so they are correct the instant
    // they do render.
    expect(store().lobby?.phase).toBe('finished');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(store().screen).toBe('over');
    room.dropAll();
  });

  it('is beaten by a player who leaves during it', async () => {
    await atTheTable();
    room.say('lobbyState', { lobby: lobby('finished') });
    await flush();
    expect(store().screen).toBe('game');

    store().leaveRoom();
    await flush(1);
    expect(store().screen).toBe('home');

    // The pending hold must not drag them back to the standings of a round they
    // walked away from.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(store().screen).toBe('home');
    room.dropAll();
  });

  it('is beaten by the room closing during it', async () => {
    /*
     * The case the original guard missed entirely. A close keeps the screen for
     * every reason except a voluntary leave — deliberately, so the dialog
     * explaining it can be drawn over the table — so a hold guarded on "am I still
     * on the game screen" would have fired and shown standings for a round that
     * was interrupted.
     */
    await atTheTable();
    room.say('lobbyState', { lobby: lobby('finished') });
    await flush();

    room.say('roomClosed', { reason: 'roomClosed' });
    await flush();

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(store().screen).not.toBe('over');
    room.dropAll();
  });

  it('shows the standings once, however many lobby updates arrive', async () => {
    await atTheTable();
    // A health re-grade re-emits the lobby, so more than one is entirely normal.
    room.say('lobbyState', { lobby: lobby('finished') });
    room.say('lobbyState', { lobby: lobby('finished') });
    room.say('lobbyState', { lobby: lobby('finished') });
    await flush();
    expect(store().screen).toBe('game');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(store().screen).toBe('over');
    room.dropAll();
  });

  it('does not hold when the round ends while nobody is at the table', async () => {
    await atTheTable();
    // Back to the lobby first: from anywhere but the table, a finished round is
    // shown immediately, because there is no last card to watch land.
    room.say('lobbyState', { lobby: lobby('lobby') });
    await flush();
    expect(store().screen).toBe('lobby');

    room.say('lobbyState', { lobby: lobby('finished') });
    await flush();
    expect(store().screen).toBe('over');
    room.dropAll();
  });

  it('lets a new round start without waiting', async () => {
    await atTheTable();
    room.say('lobbyState', { lobby: lobby('finished') });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(store().screen).toBe('over');

    room.say('lobbyState', { lobby: lobby('inGame') });
    await flush();
    expect(store().screen).toBe('game');
    room.dropAll();
  });
});
