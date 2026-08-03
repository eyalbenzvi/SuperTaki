import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryNetwork } from '../../../src/features/game/network/memoryTransport.ts';
import { createHostSession, type HostSession } from '../../../src/features/game/network/hostSession.ts';
import { TransportError } from '../../../src/features/game/network/transport.ts';
import { hostPeerIdForRoom } from '../../../src/features/game/network/roomCode.ts';
import { useAppStore } from '../../../src/features/game/state/store.ts';
import { TEST_ROOM, createRecorder, flush } from '../helpers/net.ts';

/**
 * Drives the real store against the in-memory transport, so the mapping from
 * session updates to renderable state is covered end to end.
 */
const holder = vi.hoisted(() => ({
  create: null as ((id?: string) => unknown) | null,
  failNextWith: null as Error | null,
}));

vi.mock('../../../src/features/game/network/transportFactory.ts', () => ({
  readTransportKind: () => 'memory',
  createTransport: (options: { id?: string } = {}) => {
    if (holder.failNextWith) {
      const error = holder.failNextWith;
      holder.failNextWith = null;
      throw error;
    }
    if (!holder.create) {
      throw new Error('test transport not installed');
    }
    return holder.create(options.id);
  },
}));

type Store = ReturnType<typeof useAppStore.getState>;

const PRISTINE: Store = { ...useAppStore.getState() };
let network: MemoryNetwork;

beforeEach(() => {
  network = new MemoryNetwork();
  holder.create = (id?: string) => network.create(id);
  holder.failNextWith = null;
  useAppStore.setState({ ...PRISTINE }, true);
});

afterEach(() => {
  useAppStore.getState().leaveRoom();
  localStorage.clear();
});

function store(): Store {
  return useAppStore.getState();
}

async function startHost(): Promise<{
  host: HostSession;
  recorder: ReturnType<typeof createRecorder>;
}> {
  const recorder = createRecorder();
  const host = await createHostSession({
    transport: network.create(hostPeerIdForRoom(TEST_ROOM)),
    roomCode: TEST_ROOM,
    hostDisplayName: 'Host',
    maxPlayers: 4,
    tableLanguage: 'he',
    observer: recorder.observer,
    seedFactory: () => 31337,
    heartbeatIntervalMs: 100_000,
  });
  return { host, recorder };
}

describe('creating a room through the store', () => {
  it('opens a lobby with a shareable invite link', async () => {
    await store().createRoom({ name: 'דנה', maxPlayers: 3, tableLanguage: 'he' });

    const state = store();
    expect(state.role).toBe('host');
    expect(state.screen).toBe('lobby');
    expect(state.busy).toBe(false);
    expect(state.roomCode).toMatch(/^[A-Z]+-[A-Z]+-\d{2}$/);
    expect(state.hostPeerId).toBe(hostPeerIdForRoom(state.roomCode ?? ''));
    expect(state.inviteUrl).toContain(`#/join?room=${state.roomCode ?? ''}`);
    expect(state.lobby?.players).toHaveLength(1);
    expect(state.lobby?.maxPlayers).toBe(3);
    expect(state.localPlayerId).toMatch(/^pl_/);
  });

  it('does not store resume metadata for the host', async () => {
    await store().createRoom({ name: 'דנה', maxPlayers: 2, tableLanguage: 'he' });
    expect(store().resumable).toBeNull();
    expect(localStorage.getItem('colorRush:resumableRoom')).toBeNull();
  });

  it('retries with a new room code when the first one is taken', async () => {
    holder.failNextWith = new TransportError('idUnavailable', 'taken');
    await store().createRoom({ name: 'דנה', maxPlayers: 2, tableLanguage: 'he' });

    expect(store().role).toBe('host');
    expect(store().roomCode).not.toBeNull();
    expect(store().error).toBeNull();
  });

  it('surfaces a signalling failure instead of pretending to be connected', async () => {
    holder.create = null;
    holder.failNextWith = new TransportError('signalingUnavailable', 'no service');
    await store().createRoom({ name: 'דנה', maxPlayers: 2, tableLanguage: 'he' });

    const state = store();
    expect(state.error?.code).toBe('signalingUnavailable');
    expect(state.phase).toBe('failed');
    expect(state.role).toBeNull();
    expect(state.lobby).toBeNull();
  });

  it('ignores a second create while one is in flight', async () => {
    const first = store().createRoom({ name: 'דנה', maxPlayers: 2, tableLanguage: 'he' });
    await store().createRoom({ name: 'אחר', maxPlayers: 6, tableLanguage: 'en' });
    await first;
    expect(store().lobby?.maxPlayers).toBe(2);
  });

  it('forwards host-only lobby controls', async () => {
    await store().createRoom({ name: 'דנה', maxPlayers: 2, tableLanguage: 'he' });
    store().setMaxPlayers(5);
    expect(store().lobby?.maxPlayers).toBe(5);
  });
});

describe('joining a room through the store', () => {
  it('receives the lobby, an identity and stores resume metadata', async () => {
    const { host } = await startHost();
    await store().joinRoom({ name: 'אלי', roomCode: TEST_ROOM });
    await flush();

    const state = store();
    expect(state.role).toBe('client');
    expect(state.phase).toBe('connected');
    expect(state.screen).toBe('lobby');
    expect(state.lobby?.players).toHaveLength(2);
    expect(state.localPlayerId).toMatch(/^pl_/);
    expect(state.resumable).toMatchObject({ roomCode: TEST_ROOM, displayName: 'אלי' });
    host.destroy('leftVoluntarily');
  });

  it('moves to the game screen with a private hand when the host starts', async () => {
    const { host } = await startHost();
    await store().joinRoom({ name: 'אלי', roomCode: TEST_ROOM });
    await flush();

    host.startGame();
    await flush();

    const state = store();
    expect(state.screen).toBe('game');
    expect(state.hand).toHaveLength(8);
    expect(state.publicState?.players).toHaveLength(2);
    expect(state.feed.map((entry) => entry.event.type)).toEqual(['gameStarted', 'turnChanged']);
    host.destroy('leftVoluntarily');
  });

  it('reports a rejected action with a fresh notice each time', async () => {
    const { host } = await startHost();
    await store().joinRoom({ name: 'אלי', roomCode: TEST_ROOM });
    await flush();
    host.startGame();
    await flush();

    // The host plays first, so the client is out of turn.
    store().drawCard();
    await flush();
    const first = store().rejection;
    expect(first?.code).toBe('notYourTurn');

    store().closeTaki();
    await flush();
    expect(store().rejection?.nonce).toBeGreaterThan(first?.nonce ?? 0);

    store().dismissRejection();
    expect(store().rejection).toBeNull();
    host.destroy('leftVoluntarily');
  });

  it('forwards a card play with the chosen colour', async () => {
    const { host } = await startHost();
    await store().joinRoom({ name: 'אלי', roomCode: TEST_ROOM });
    await flush();
    host.startGame();
    await flush();

    // Out of turn, but the intent must still reach the host and be judged there.
    store().playCard('n-red-5-0', 'green');
    await flush();
    expect(store().rejection?.code).toBe('notYourTurn');
    host.destroy('leftVoluntarily');
  });

  it('explains a closed room and forgets the dead seat', async () => {
    const { host } = await startHost();
    await store().joinRoom({ name: 'אלי', roomCode: TEST_ROOM });
    await flush();
    expect(store().resumable).not.toBeNull();

    host.destroy('leftVoluntarily');
    await flush();

    const state = store();
    expect(state.closedReason).toBe('hostLeft');
    expect(state.role).toBeNull();
    expect(state.lobby).toBeNull();
    expect(state.resumable).toBeNull();

    state.dismissClosed();
    expect(store().closedReason).toBeNull();
    expect(store().screen).toBe('home');
  });

  it('reports an unreachable room without leaving the player stuck', async () => {
    await store().joinRoom({ name: 'אלי', roomCode: 'TIGER-MANGO-99' });
    await flush();

    expect(store().phase).toBe('failed');
    expect(store().error?.code).toBe('peerUnavailable');
    expect(store().busy).toBe(false);
  });

  it('clears everything on leave', async () => {
    const { host } = await startHost();
    await store().joinRoom({ name: 'אלי', roomCode: TEST_ROOM });
    await flush();

    store().leaveRoom();
    const state = store();
    expect(state.screen).toBe('home');
    expect(state.role).toBeNull();
    expect(state.hand).toEqual([]);
    expect(state.feed).toEqual([]);
    expect(state.resumable).toBeNull();
    expect(localStorage.getItem('colorRush:resumableRoom')).toBeNull();
    host.destroy('leftVoluntarily');
  });
});

describe('preferences and navigation', () => {
  it('persists language and theme and applies them to the document', () => {
    store().setLanguage('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(localStorage.getItem('colorRush:language')).toBe('en');

    store().setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('colorRush:theme')).toBe('dark');
  });

  it('sanitises and persists the display name', () => {
    store().setDisplayName('  אלי  ');
    expect(store().displayName).toBe('אלי');
    expect(localStorage.getItem('colorRush:displayName')).toBe('אלי');
  });

  it('returns from the rules page to wherever it was opened', () => {
    store().goTo('create');
    store().openRules();
    expect(store().screen).toBe('rules');

    store().openRules();
    store().closeRules();
    expect(store().screen).toBe('create');
  });

  it('forgets stored resume metadata on request', () => {
    localStorage.setItem(
      'colorRush:resumableRoom',
      JSON.stringify({
        roomCode: TEST_ROOM,
        hostPeerId: hostPeerIdForRoom(TEST_ROOM),
        playerId: 'pl_x',
        resumeToken: 'a'.repeat(32),
        displayName: 'אלי',
        savedAt: Date.now(),
      }),
    );
    useAppStore.setState({ ...PRISTINE }, true);
    store().forgetResumable();
    expect(store().resumable).toBeNull();
  });

  it('dismisses an error banner', () => {
    useAppStore.setState({ error: { code: 'network', retryable: true } });
    store().dismissError();
    expect(store().error).toBeNull();
  });

  it('ignores game actions when no session is active', () => {
    expect(() => {
      store().playCard('x');
      store().drawCard();
      store().closeTaki();
      store().votePlayAgain(true);
      store().startGame();
      store().setMaxPlayers(4);
      store().removePlayer('nobody');
      store().retryConnection();
    }).not.toThrow();
  });
});
