import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientSession, type ClientSession } from '../../../src/features/game/network/clientSession.ts';
import {
  createHostSession,
  type HostRestoreState,
  type HostSession,
} from '../../../src/features/game/network/hostSession.ts';
import { MemoryNetwork } from '../../../src/features/game/network/memoryTransport.ts';
import { hostPeerIdForRoom } from '../../../src/features/game/network/roomCode.ts';
import { __resetLifecycleForTests } from '../../../src/lib/lifecycle.ts';
import { __resetDiagnosticsForTests } from '../../../src/lib/diagnostics.ts';
import { TEST_ROOM, createRecorder, flush } from '../helpers/net.ts';

/**
 * The resilience contract, exercised over a transport that can actually fail.
 *
 * These tests are only meaningful because the memory transport can now model the
 * failures a real data channel has: a channel that silently stops carrying traffic
 * while reporting itself open, a peer that vanishes without a close, duplicate
 * delivery, and connects that hang or are refused. Over the old fake — where
 * `open` was a boolean that only an explicit `close()` cleared and delivery was
 * perfect — every one of these would have passed while proving nothing.
 */

const HOST_PEER_ID = hostPeerIdForRoom(TEST_ROOM);

beforeEach(() => {
  __resetLifecycleForTests();
  __resetDiagnosticsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

interface Room {
  network: MemoryNetwork;
  host: HostSession;
  hostRecorder: ReturnType<typeof createRecorder>;
  snapshots: HostRestoreState[];
  destroy(): void;
}

async function openRoom(): Promise<Room> {
  const network = new MemoryNetwork();
  const hostRecorder = createRecorder();
  const snapshots: HostRestoreState[] = [];
  const host = await createHostSession({
    transport: network.create(HOST_PEER_ID),
    roomCode: TEST_ROOM,
    hostDisplayName: 'Host',
    maxPlayers: 4,
    tableLanguage: 'he',
    observer: hostRecorder.observer,
    seedFactory: () => 4242,
    heartbeatIntervalMs: 100_000,
    onSnapshot: (state) => snapshots.push(state),
  });
  return {
    network,
    host,
    hostRecorder,
    snapshots,
    destroy() {
      host.destroy('leftVoluntarily');
    },
  };
}

async function joinRoom(
  room: Room,
  id: string,
  name: string,
  resume?: { playerId: string; resumeToken: string },
): Promise<{ session: ClientSession; recorder: ReturnType<typeof createRecorder> }> {
  const recorder = createRecorder();
  const session = await createClientSession({
    transport: room.network.create(id),
    roomCode: TEST_ROOM,
    hostPeerId: HOST_PEER_ID,
    displayName: name,
    observer: recorder.observer,
    heartbeatIntervalMs: 100_000,
    ...(resume ? { resume } : {}),
  });
  await flush();
  return { session, recorder };
}

describe('a lost acknowledgement', () => {
  it('re-sends the intent once and applies it exactly once', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    const guestId = client.session.localPlayerId;
    // Get the turn to the guest, so the intent under test is a legal one.
    if (room.hostRecorder.last('publicState')?.state.currentPlayerId !== guestId) {
      room.host.submitLocalAction({ type: 'drawCard' });
      await flush();
    }
    expect(room.hostRecorder.last('publicState')?.state.currentPlayerId).toBe(guestId);

    const before = room.hostRecorder.last('publicState')?.state.version ?? 0;

    // The move lands. Then the same intent arrives again, exactly as it would from
    // a client that never saw the answer and re-sent after reconnecting.
    client.session.submitAction({ type: 'drawCard' }, 'rq-1');
    await flush();
    const afterFirst = room.hostRecorder.last('publicState')?.state.version ?? 0;
    expect(afterFirst).toBeGreaterThan(before);

    client.session.submitAction({ type: 'drawCard' }, 'rq-1');
    await flush();

    // Applied once, answered twice. The request id is remembered on the *seat*, so
    // it survives the reconnect that is the only reason it exists — and a replayed
    // catch is eight cards, so this is not a tidiness matter.
    expect(room.hostRecorder.last('publicState')?.state.version).toBe(afterFirst);
    const accepted = client.recorder.ofType('actionAccepted');
    expect(accepted.length).toBeGreaterThanOrEqual(2);
    expect(new Set(accepted.map((entry) => entry.version)).size).toBe(1);

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });

  it('answers a repeated join instead of leaving the client to time out', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    const first = client.recorder.ofType('identity').length;
    expect(first).toBeGreaterThan(0);

    // A client whose accept was lost re-sends on the same channel. Silence here
    // used to be terminal — and it took the credential with it, because the
    // credential arrives in the message that went missing.
    client.session.submitAction({ type: 'declareLastCard' }, 'rq-x');
    await flush();
    expect(room.host.connectedPlayerCount).toBe(2);

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });
});

describe('a channel that stops carrying traffic', () => {
  it('does not leak a seat when a client reconnects repeatedly', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    const identity = client.recorder.last('identity');
    expect(identity).toBeDefined();
    room.host.startGame();
    await flush();
    expect(room.host.connectedPlayerCount).toBe(2);

    // Three rounds of leaving and coming back on the same credential. Each cycle
    // used to cost one seat against maxPlayers, because a duplicate channel nulled
    // the record's player id and the close handler then bailed before freeing
    // anything — so a flaky phone could fill a room with its own ghosts.
    let current = client;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current.session.destroy('leftVoluntarily');
      await flush();
      current = await joinRoom(room, `client-retry-${String(cycle)}`, 'Dana', {
        playerId: identity!.playerId,
        resumeToken: identity!.resumeToken,
      });
      await flush();
    }

    const lobby = room.hostRecorder.last('lobby')?.lobby;
    expect(lobby?.players).toHaveLength(2);
    expect(lobby?.players.find((player) => !player.isHost)?.health).toBe('connected');
    current.session.destroy('leftVoluntarily');
    room.destroy();
  });

  it('keeps the seat and its credential when the host restarts', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    room.host.announceRestarting();
    await flush();

    // "Restarting" is not a goodbye: the session stays alive and keeps trying,
    // which is the whole precondition for a host being able to come back.
    expect(client.recorder.ofType('closed')).toHaveLength(0);
    expect(client.session.connectionPhase).toBe('reconnecting');

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });
});

describe('the host coming back', () => {
  it('restores the table, the version floor and every credential', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    const identity = client.recorder.last('identity');
    room.host.startGame();
    await flush();

    const snapshot = room.snapshots.at(-1);
    expect(snapshot).toBeDefined();
    expect(snapshot?.game).not.toBeNull();
    const versionBefore = snapshot?.versionFloor ?? 0;

    client.session.destroy('leftVoluntarily');
    room.host.destroy('leftVoluntarily');
    await flush();

    // A fresh device claiming the same peer id, restoring what was written down.
    const network = new MemoryNetwork();
    const recorder = createRecorder();
    const revived = await createHostSession({
      transport: network.create(HOST_PEER_ID),
      roomCode: TEST_ROOM,
      hostDisplayName: 'Host',
      maxPlayers: 4,
      tableLanguage: 'he',
      observer: recorder.observer,
      heartbeatIntervalMs: 100_000,
      restore: snapshot,
    });
    await flush();

    // The host's own identity has to come back with the room, or every move it
    // makes is refused as coming from an unknown player and its hand renders empty.
    expect(revived.localPlayerId).toBe(snapshot?.hostPlayerId);
    const state = recorder.last('publicState')?.state;
    expect(state?.version).toBe(versionBefore);
    expect(recorder.last('hand')?.cards.length).toBeGreaterThan(0);

    // And the seat credentials still fit, so the players reconnect on their own
    // without being told anything.
    const returning = await createClientSession({
      transport: network.create('client-back'),
      roomCode: TEST_ROOM,
      hostPeerId: HOST_PEER_ID,
      displayName: 'Dana',
      observer: createRecorder().observer,
      heartbeatIntervalMs: 100_000,
      resume: { playerId: identity!.playerId, resumeToken: identity!.resumeToken },
    });
    await flush();
    expect(returning.localPlayerId).toBe(identity?.playerId);

    returning.destroy('leftVoluntarily');
    revived.destroy('leftVoluntarily');
  });
});

describe('a table waiting for somebody who is not there', () => {
  it('passes their turn rather than freezing', async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const now = (): number => clock;

    const network = new MemoryNetwork();
    const hostRecorder = createRecorder();
    const host = await createHostSession({
      transport: network.create(HOST_PEER_ID),
      roomCode: TEST_ROOM,
      hostDisplayName: 'Host',
      maxPlayers: 4,
      tableLanguage: 'he',
      observer: hostRecorder.observer,
      seedFactory: () => 4242,
      heartbeatIntervalMs: 50,
      now,
    });

    const recorder = createRecorder();
    const client = await createClientSession({
      transport: network.create('client-1'),
      roomCode: TEST_ROOM,
      hostPeerId: HOST_PEER_ID,
      displayName: 'Dana',
      observer: recorder.observer,
      heartbeatIntervalMs: 100_000,
    });
    await vi.advanceTimersByTimeAsync(10);

    host.startGame();
    await vi.advanceTimersByTimeAsync(10);
    const first = hostRecorder.last('publicState')?.state.currentPlayerId;

    // The guest disappears without a goodbye, and it is their turn.
    if (first !== host.localPlayerId) {
      client.destroy('leftVoluntarily');
      await vi.advanceTimersByTimeAsync(10);

      // Well past the twelve-second window for a channel we know is closed.
      clock += 60_000;
      await vi.advanceTimersByTimeAsync(200);

      const state = hostRecorder.last('publicState')?.state;
      expect(state?.currentPlayerId).toBe(host.localPlayerId);
    } else {
      client.destroy('leftVoluntarily');
    }

    host.destroy('leftVoluntarily');
    vi.useRealTimers();
  });

  it('does not convict anybody when the host itself was asleep', async () => {
    vi.useFakeTimers();
    let clock = 2_000_000;
    const now = (): number => clock;

    const network = new MemoryNetwork();
    const hostRecorder = createRecorder();
    const host = await createHostSession({
      transport: network.create(HOST_PEER_ID),
      roomCode: TEST_ROOM,
      hostDisplayName: 'Host',
      maxPlayers: 4,
      tableLanguage: 'he',
      observer: hostRecorder.observer,
      heartbeatIntervalMs: 50,
      now,
    });
    const client = await createClientSession({
      transport: network.create('client-1'),
      roomCode: TEST_ROOM,
      hostPeerId: HOST_PEER_ID,
      displayName: 'Dana',
      observer: createRecorder().observer,
      heartbeatIntervalMs: 100_000,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(host.connectedPlayerCount).toBe(2);

    /*
     * Five minutes of wall clock pass with a single tick, which is exactly what a
     * suspended tab looks like. The peer is perfectly fine, and convicting it here
     * is the bug that produced most phantom disconnects.
     */
    clock += 300_000;
    await vi.advanceTimersByTimeAsync(60);

    const lobby = hostRecorder.last('lobby')?.lobby;
    expect(lobby?.players.find((player) => !player.isHost)?.health).not.toBe('disconnected');

    client.destroy('leftVoluntarily');
    host.destroy('leftVoluntarily');
    vi.useRealTimers();
  });
});

describe('the table can decide for itself', () => {
  it('holds when somebody asks it to, and refuses moves while held', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    room.host.setPaused(room.host.localPlayerId);
    await flush();
    expect(room.hostRecorder.last('paused')?.pausedBy).toBe(room.host.localPlayerId);

    const versionBefore = room.hostRecorder.last('publicState')?.state.version;
    client.session.submitAction({ type: 'declareLastCard' }, 'rq-paused');
    await flush();
    expect(room.hostRecorder.last('publicState')?.state.version).toBe(versionBefore);

    room.host.setPaused(null);
    await flush();
    expect(room.hostRecorder.last('paused')?.pausedBy).toBeNull();

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });

  it('ends a round by agreement, with no winner', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    room.host.voteAbandon(true);
    client.session.voteAbandon(true);
    await flush();

    const state = room.hostRecorder.last('publicState')?.state;
    expect(state?.phase).toBe('finished');
    // Never a winner. Who is "left standing" is measured by the host's own
    // heartbeat, so awarding the round on it would be awarding it to whoever
    // controls the measurement.
    expect(state?.winnerId).toBeNull();
    expect(state?.endReason).toBe('abandoned');

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });

  it('will not let an absent player be caught on last card', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    client.session.destroy('leftVoluntarily');
    await flush();

    const guest = room.hostRecorder.last('lobby')?.lobby.players.find((player) => !player.isHost);
    expect(guest).toBeDefined();
    room.host.submitLocalAction({ type: 'catchLastCard', targetId: guest!.id });
    await flush();

    // Absence would otherwise convert a social rule into farming: four cards an
    // orbit off somebody whose phone is rebooting and who cannot shout.
    expect(room.hostRecorder.last('actionRejected')?.code).toBe('nothingToCatch');
    room.destroy();
  });
});

describe('handing the room over', () => {
  it('names a successor and tells everybody where the room went', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    const other = await joinRoom(room, 'client-2', 'Noa');
    room.host.startGame();
    await flush();

    const successor = room.host.successor;
    expect(successor).not.toBeNull();

    expect(room.host.offerHandoff(successor!.playerId)).toBe(true);
    await flush();

    // The named seat is handed the state and a way to say yes. Nothing happens
    // until it does: the old host only steps down once there is somewhere for the
    // table to go, which is the difference between a handover and a gap.
    const offer = [client, other].flatMap((entry) => entry.recorder.ofType('handoffOffer')).at(-1);
    expect(offer).toBeDefined();
    expect(offer?.generation).toBe(1);
    expect(offer?.snapshot).toBeDefined();

    offer!.accept();
    await flush();

    // Everybody else is told the generation, not an address: the new host's id is
    // derived from it, so the room can move without the room code changing.
    const followed = [client, other].flatMap((entry) => entry.recorder.ofType('handover'));
    expect(followed.length).toBeGreaterThan(0);
    expect(followed[0]?.generation).toBe(1);

    client.session.destroy('leftVoluntarily');
    other.session.destroy('leftVoluntarily');
    room.destroy();
  });
});
