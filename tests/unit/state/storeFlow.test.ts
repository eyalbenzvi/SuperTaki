import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryNetwork } from '../../../src/features/game/network/memoryTransport.ts';
import { createClientSession, type ClientSession } from '../../../src/features/game/network/clientSession.ts';
import {
  createHostSession,
  type HostRestoreState,
  type HostSession,
} from '../../../src/features/game/network/hostSession.ts';
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
    expect(localStorage.getItem('superTaki:resumableRoom')).toBeNull();
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

  it('surfaces a signalling timeout and tears the transport down', async () => {
    // A transport whose `ready()` never opens is exactly what the free public
    // broker produces when it accepts a socket and goes quiet.
    const destroy = vi.fn();
    holder.create = () => ({
      kind: 'peerjs',
      localId: null,
      ready: () => Promise.reject(new TransportError('signalingUnavailable', 'no response')),
      connect: () => Promise.reject(new TransportError('closed', 'n/a')),
      onIncoming: () => () => {},
      onError: () => () => {},
      destroy,
    });

    await store().createRoom({ name: 'דנה', maxPlayers: 2, tableLanguage: 'he' });

    const state = store();
    expect(state.error?.code).toBe('signalingUnavailable');
    expect(state.phase).toBe('failed');
    expect(state.busy).toBe(false);
    expect(state.roomCode).toBeNull();
    // The abandoned peer must not be left holding a socket.
    expect(destroy).toHaveBeenCalled();
  });

  it('tears down each abandoned transport while retrying a taken room code', async () => {
    const destroy = vi.fn();
    let attempts = 0;
    const realCreate = (id?: string) => network.create(id);
    holder.create = (id?: string) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          kind: 'peerjs',
          localId: null,
          ready: () => Promise.reject(new TransportError('idUnavailable', 'taken')),
          connect: () => Promise.reject(new TransportError('closed', 'n/a')),
          onIncoming: () => () => {},
          onError: () => () => {},
          destroy,
        };
      }
      return realCreate(id);
    };

    await store().createRoom({ name: 'דנה', maxPlayers: 2, tableLanguage: 'he' });

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(store().role).toBe('host');
    expect(store().error).toBeNull();
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

  it('explains a closed room but keeps the way back into it', async () => {
    /*
     * This used to assert the opposite, and the opposite was a real bug: the
     * credential was destroyed for every close reason except one, including a host
     * that had merely reloaded. So the one thing a player needed in order to
     * return was thrown away at precisely the moment they needed it, and every
     * plan to let a host come back was impossible to build on top of it.
     *
     * The credential now survives everything except the two reasons that genuinely
     * end a seat: leaving on purpose, and being removed.
     */
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
    expect(state.resumable).not.toBeNull();

    state.dismissClosed();
    expect(store().closedReason).toBeNull();
    expect(store().screen).toBe('home');
  });

  it('forgets the seat only when the player leaves or is removed', async () => {
    const { host } = await startHost();
    await store().joinRoom({ name: 'אלי', roomCode: TEST_ROOM });
    await flush();
    expect(store().resumable).not.toBeNull();

    store().leaveRoom();
    await flush();
    expect(store().resumable).toBeNull();
    host.destroy('leftVoluntarily');
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
    expect(localStorage.getItem('superTaki:resumableRoom')).toBeNull();
    host.destroy('leftVoluntarily');
  });
});

describe('preferences and navigation', () => {
  it('persists language and theme and applies them to the document', () => {
    store().setLanguage('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(localStorage.getItem('superTaki:language')).toBe('en');

    store().setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('superTaki:theme')).toBe('dark');
  });

  it('sanitises and persists the display name', () => {
    store().setDisplayName('  אלי  ');
    expect(store().displayName).toBe('אלי');
    expect(localStorage.getItem('superTaki:displayName')).toBe('אלי');
  });

  it('forgets stored resume metadata on request', () => {
    localStorage.setItem(
      'superTaki:resumableRoom',
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

  it('locks the table while a move is unanswered, so one tap cannot become two', async () => {
    const { host } = await startHost();
    await store().joinRoom({ name: 'אלי', roomCode: TEST_ROOM });
    await flush();
    host.startGame();
    await flush();

    expect(store().actionPending).toBe(false);
    store().drawCard();
    // The intent is on the wire and nothing has come back yet.
    expect(store().actionPending).toBe(true);

    // A second tap in that window is dropped rather than sent twice.
    store().drawCard();
    expect(store().actionPending).toBe(true);

    await flush();
    // The host's answer — a rejection here, since it is not this seat's turn —
    // releases the lock, so a dropped packet can never freeze the hand.
    expect(store().actionPending).toBe(false);
    host.destroy('leftVoluntarily');
  });

  it('tracks the leave request separately from leaving', () => {
    store().requestLeave();
    expect(store().leaveIntent).toBe(true);
    store().cancelLeave();
    expect(store().leaveIntent).toBe(false);
  });

  it('re-announces the same message by bumping its nonce', () => {
    store().announce('תור שלך');
    const first = store().announcement;
    expect(first?.text).toBe('תור שלך');

    store().announce('תור שלך');
    expect(store().announcement?.nonce).toBeGreaterThan(first?.nonce ?? 0);

    // Nothing to say is not a message.
    store().announce('');
    expect(store().announcement?.text).toBe('תור שלך');
  });

  it('records whether the device has a network at all', () => {
    store().setOnline(false);
    expect(store().online).toBe(false);
    store().setOnline(true);
    expect(store().online).toBe(true);
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

  it('keeps the new session when a superseded one reports its own closure', async () => {
    /*
     * The blocker this pins, driven through the real handover rather than described.
     *
     * A session's observer is fixed at construction, so a session that has been
     * replaced can still speak — and the last thing it says is `closed`, which
     * clears the store's session handle. Taking over a room installs the new host
     * session and *then* tears down the client session this device used to be, so
     * that teardown would null out the host that had just been created: the room
     * would be served by an object nothing could reach, and every subsequent tap
     * would do nothing at all. The earlier version of this test stood up a second
     * room, never adopted it, never destroyed anything, and asserted after nothing
     * had happened.
     */
    const { host } = await startHost();
    await store().joinRoom({ name: 'אלי', roomCode: TEST_ROOM });
    await flush();
    expect(store().role).toBe('client');
    const me = store().localPlayerId;
    expect(me).not.toBeNull();

    // The host hands the room over and leaves. Its own session is destroyed as part
    // of completing the handover, so the successor is genuinely on its own.
    expect(host.offerHandoff(me as string)).toBe(true);
    await flush();
    // Twice: the superseded client session is destroyed on a microtask *after* the
    // host session has been installed, which is the ordering the bug depended on.
    await flush();

    expect(store().role).toBe('host');
    expect(store().roomCode).toBe(TEST_ROOM);
    expect(store().hostPeerId).toBe(hostPeerIdForRoom(TEST_ROOM, 1));
    expect(store().error).toBeNull();
    expect(store().screen).not.toBe('landing');

    /*
     * And the handle is live rather than merely non-null: a store action has to
     * reach the session it points at. Raising the seat count is the cheapest command
     * that comes back through the lobby, and it only exists on a host.
     */
    store().setMaxPlayers(5);
    await flush();
    expect(store().lobby?.maxPlayers).toBe(5);

    host.destroy('leftVoluntarily');
  });
});

describe('taking a hosted room back', () => {
  /** The minimum a snapshot needs to be worth restoring: a lobby with one seat. */
  function hostedRoom(): {
    roomCode: string;
    hostPeerId: string;
    generation: number;
    savedAt: number;
    restore: HostRestoreState;
  } {
    return {
      roomCode: TEST_ROOM,
      hostPeerId: hostPeerIdForRoom(TEST_ROOM),
      generation: 0,
      savedAt: Date.now(),
      restore: {
        hostPlayerId: 'pl_host000000',
        phase: 'lobby',
        maxPlayers: 4,
        tableLanguage: 'he',
        versionFloor: 7,
        round: 1,
        seats: [
          {
            playerId: 'pl_host000000',
            name: 'דנה',
            seat: 0,
            isHost: true,
            resumeToken: 'tok_host',
          },
        ],
        game: null,
      },
    };
  }

  it('reclaims the room code and serves the same room again', async () => {
    /*
     * The point of the whole host-restart path: a host who reloads — or whose phone
     * killed the tab — comes back to the room they were already running, on the same
     * code, so every invitation already sent still works.
     */
    useAppStore.setState({ hostable: hostedRoom() });
    await store().resumeHosting();

    expect(store().role).toBe('host');
    expect(store().roomCode).toBe(TEST_ROOM);
    expect(store().busy).toBe(false);
    expect(store().error).toBeNull();
    expect(store().inviteUrl).toContain(TEST_ROOM);
    // The restored seat is served, not a fresh empty lobby.
    expect(store().lobby?.players.map((player) => player.name)).toContain('דנה');

    // And the handle is live: a host-only command has to reach it.
    store().setMaxPlayers(5);
    await flush();
    expect(store().lobby?.maxPlayers).toBe(5);
  });

  it('gives up on a failure that retrying cannot fix', async () => {
    // An id that is *taken* is worth retrying for a minute — the broker holds a
    // dropped peer id that long. Signalling being unreachable is not.
    useAppStore.setState({ hostable: hostedRoom() });
    holder.failNextWith = new TransportError('signalingUnavailable', 'no service');
    await store().resumeHosting();

    expect(store().phase).toBe('failed');
    expect(store().error?.code).toBe('signalingUnavailable');
    expect(store().busy).toBe(false);
  });

  it('does not republish a room the player has since let go', async () => {
    /*
     * The reclaim loop can run for over a minute. Somebody who gives up and walks
     * away in the middle of it must not have the room reinstated under them by an
     * attempt that finally succeeded.
     */
    useAppStore.setState({ hostable: hostedRoom() });
    const pending = store().resumeHosting();
    store().forgetHostable();
    await pending;
    expect(store().lobby).toBeNull();
    // And not left in limbo either: `busy` used to stay set, so the player watched a
    // spinner for a room nobody was going to reclaim.
    expect(store().busy).toBe(false);
    expect(store().role).toBeNull();
    expect(store().screen).toBe('home');
  });
});

describe('the table controls, through the store', () => {
  /** The store hosting a two-seat room, with a real client session opposite it. */
  async function hostedTable(): Promise<{ client: ClientSession; guestId: string }> {
    await store().createRoom({ name: 'דנה', maxPlayers: 2, tableLanguage: 'he' });
    const roomCode = store().roomCode as string;
    const client = await createClientSession({
      transport: network.create('client-1'),
      roomCode,
      hostPeerId: hostPeerIdForRoom(roomCode),
      displayName: 'אלי',
      observer: createRecorder().observer,
      heartbeatIntervalMs: 100_000,
    });
    await flush();
    const guest = store().lobby?.players.find((player) => !player.isHost);
    expect(guest).toBeDefined();
    return { client, guestId: guest?.id as string };
  }

  it('holds the table and lets it carry on', async () => {
    const { client } = await hostedTable();
    store().startGame();
    await flush();

    store().setPaused(true);
    await flush();
    expect(store().pausedBy).toBe(store().localPlayerId);

    store().setPaused(false);
    await flush();
    expect(store().pausedBy).toBeNull();
    client.destroy('leftVoluntarily');
  });

  it('ends the round when everybody present agrees', async () => {
    const { client } = await hostedTable();
    store().startGame();
    await flush();

    // One of two seats is not enough: abandoning is irreversible, so it takes
    // everybody who is here rather than a bare majority.
    store().voteAbandon(true);
    await flush();
    expect(store().publicState?.phase).toBe('playing');

    client.voteAbandon(true);
    await flush();
    expect(store().publicState?.phase).toBe('finished');
    expect(store().publicState?.endReason).toBe('abandoned');
    client.destroy('leftVoluntarily');
  });

  it('passes and then retires the turn of a seat that is away', async () => {
    const { client, guestId } = await hostedTable();
    store().startGame();
    await flush();
    // The guest leaves without a word, so the host is the one who has to act.
    client.destroy('leftVoluntarily');
    await flush();

    // Seat 0 leads, which is the host; drawing hands the turn to the absent seat, so
    // there is actually something to pass. A skip aimed at a seat that is not on turn
    // is refused, correctly, and would make the rest of this prove nothing.
    expect(store().publicState?.currentPlayerId).toBe(store().localPlayerId);
    store().drawCard();
    await flush();
    expect(store().publicState?.currentPlayerId).toBe(guestId);

    store().skipAbsentTurn(guestId);
    await flush();
    // Passed, and it cost them no cards: a skip is not a draw.
    expect(store().publicState?.currentPlayerId).not.toBe(guestId);

    store().removeFromRound(guestId);
    await flush();
    // Two seats, one of them retired: the round cannot continue and ends honestly
    // rather than declaring the last player standing a winner.
    expect(store().publicState?.phase).toBe('finished');
    expect(store().publicState?.endReason).toBe('abandoned');
  });

  it('sends a host who has handed the room over back to the start', async () => {
    /*
     * Handing over ends this device's session for the most voluntary reason there is,
     * so nothing is explained and no dialog is drawn — which left the outgoing host on
     * a lobby screen with no lobby behind it and nothing to press.
     */
    await store().createRoom({ name: 'דנה', maxPlayers: 2, tableLanguage: 'he' });
    const roomCode = store().roomCode as string;
    // A guest that actually takes the offer up. The store is the only thing that can
    // start a host session, so on a real device this is the other player's store; here
    // it is enough that somebody answers, because what is under test is what happens
    // to the host that leaves.
    const client = await createClientSession({
      transport: network.create('client-1'),
      roomCode,
      hostPeerId: hostPeerIdForRoom(roomCode),
      displayName: 'אלי',
      observer: (update) => {
        if (update.type === 'handoffOffer') {
          update.accept();
        }
      },
      heartbeatIntervalMs: 100_000,
    });
    await flush();
    const guestId = store().lobby?.players.find((player) => !player.isHost)?.id as string;

    store().handOver(guestId);
    await flush();

    expect(store().screen).toBe('home');
    expect(store().role).toBeNull();
    expect(store().lobby).toBeNull();
    // And no offer to reclaim a room somebody else is now running.
    expect(store().hostable).toBeNull();
    client.destroy('leftVoluntarily');
  });

  it('nudges a seat that is present and not looking', async () => {
    const { client, guestId } = await hostedTable();
    const nudged: string[] = [];
    client.destroy('leftVoluntarily');
    const listening = await createClientSession({
      transport: network.create('client-2'),
      roomCode: store().roomCode as string,
      hostPeerId: hostPeerIdForRoom(store().roomCode as string),
      displayName: 'אלי',
      observer: (update) => {
        if (update.type === 'nudged') {
          nudged.push(update.fromPlayerId);
        }
      },
      heartbeatIntervalMs: 100_000,
    });
    await flush();

    const target = store().lobby?.players.find((player) => !player.isHost)?.id ?? guestId;
    store().nudgePlayer(target);
    await flush();
    expect(nudged).toEqual([store().localPlayerId]);
    listening.destroy('leftVoluntarily');
  });
});
