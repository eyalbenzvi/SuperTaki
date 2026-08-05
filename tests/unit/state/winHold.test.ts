import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryNetwork } from '../../../src/features/game/network/memoryTransport.ts';
import { hostPeerIdForRoom } from '../../../src/features/game/network/roomCode.ts';
import { useAppStore } from '../../../src/features/game/state/store.ts';
import { TEST_ROOM, createScriptedPeer, flush } from '../helpers/net.ts';

/**
 * Holding the table for a beat after somebody wins.
 *
 * Written failure-first, because the risk here is not that the hold fails to
 * happen — it is that the hold happens when the player is no longer looking at the
 * table. Every one of these was reachable with the guard this originally had.
 */
const holder = vi.hoisted(() => ({ create: null as ((id?: string) => unknown) | null }));

vi.mock('../../../src/features/game/network/transportFactory.ts', () => ({
  readTransportKind: () => 'memory',
  createTransport: (options: { id?: string } = {}) => {
    if (!holder.create) {
      throw new Error('test transport not installed');
    }
    return holder.create(options.id);
  },
}));

type Store = ReturnType<typeof useAppStore.getState>;
const PRISTINE: Store = { ...useAppStore.getState() };
const HOST_PEER = hostPeerIdForRoom(TEST_ROOM);
const ME = 'pl_client000';
const THEM = 'pl_host00000';

let network: MemoryNetwork;

beforeEach(() => {
  network = new MemoryNetwork();
  holder.create = (id?: string) => network.create(id);
  useAppStore.setState({ ...PRISTINE }, true);
});

afterEach(() => {
  vi.useRealTimers();
});

function store(): Store {
  return useAppStore.getState();
}

function lobby(phase: 'lobby' | 'inGame' | 'finished'): Record<string, unknown> {
  return {
    roomCode: TEST_ROOM,
    hostPeerId: HOST_PEER,
    hostPlayerId: THEM,
    maxPlayers: 4,
    phase,
    tableLanguage: 'he',
    players: [
      { id: THEM, name: 'Dana', isHost: true, health: 'connected', seat: 0 },
      { id: ME, name: 'Bob', isHost: false, health: 'connected', seat: 1 },
    ],
  };
}

async function atTheTable(): Promise<ReturnType<typeof createScriptedPeer>> {
  const host = createScriptedPeer(network, HOST_PEER);
  await store().joinRoom({ name: 'Bob', roomCode: TEST_ROOM });
  await flush();
  host.send(
    host.envelope('joinAccepted', {
      playerId: ME,
      resumeToken: 'b'.repeat(32),
      displayName: 'Bob',
      lobby: lobby('inGame'),
    }),
  );
  await flush();
  expect(store().screen).toBe('game');
  return host;
}

describe('the win hold', () => {
  it('keeps the table up for a moment, then shows the standings', async () => {
    const host = await atTheTable();
    host.send(host.envelope('lobbyState', { lobby: lobby('finished') }));
    await flush();

    // Still on the table: the winning card is landing.
    expect(store().screen).toBe('game');
    // But the standings already have their data, so they are correct the instant
    // they do render.
    expect(store().lobby?.phase).toBe('finished');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(store().screen).toBe('over');
    host.close();
  });

  it('is beaten by a player who leaves during it', async () => {
    const host = await atTheTable();
    host.send(host.envelope('lobbyState', { lobby: lobby('finished') }));
    await flush();
    expect(store().screen).toBe('game');

    store().leaveRoom();
    await flush(1);
    expect(store().screen).toBe('home');

    // The pending hold must not drag them back to the standings of a round they
    // walked away from.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(store().screen).toBe('home');
    host.close();
  });

  it('is beaten by the room closing during it', async () => {
    /*
     * The case the original guard missed entirely. A close keeps the screen for
     * every reason except a voluntary leave — deliberately, so the dialog
     * explaining it can be drawn over the table — so a hold guarded on "am I still
     * on the game screen" would have fired and shown standings for a round that
     * was interrupted.
     */
    const host = await atTheTable();
    host.send(host.envelope('lobbyState', { lobby: lobby('finished') }));
    await flush();

    host.send(host.envelope('hostClosed', { reason: 'hostLeft' }));
    await flush();

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(store().screen).not.toBe('over');
    host.close();
  });

  it('shows the standings once, however many lobby updates arrive', async () => {
    const host = await atTheTable();
    // A health re-grade re-emits the lobby, so more than one is entirely normal.
    host.send(host.envelope('lobbyState', { lobby: lobby('finished') }));
    host.send(host.envelope('lobbyState', { lobby: lobby('finished') }));
    host.send(host.envelope('lobbyState', { lobby: lobby('finished') }));
    await flush();
    expect(store().screen).toBe('game');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(store().screen).toBe('over');
    host.close();
  });

  it('does not hold when the round ends while nobody is at the table', async () => {
    const host = await atTheTable();
    // Back to the lobby first: from anywhere but the table, a finished round is
    // shown immediately, because there is no last card to watch land.
    host.send(host.envelope('lobbyState', { lobby: lobby('lobby') }));
    await flush();
    expect(store().screen).toBe('lobby');

    host.send(host.envelope('lobbyState', { lobby: lobby('finished') }));
    await flush();
    expect(store().screen).toBe('over');
    host.close();
  });

  it('lets a new round start without waiting', async () => {
    const host = await atTheTable();
    host.send(host.envelope('lobbyState', { lobby: lobby('finished') }));
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(store().screen).toBe('over');

    host.send(host.envelope('lobbyState', { lobby: lobby('inGame') }));
    await flush();
    expect(store().screen).toBe('game');
    host.close();
  });
});
