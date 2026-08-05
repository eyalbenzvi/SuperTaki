import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientSession, type ClientSession } from '../../../src/features/game/network/clientSession.ts';
import {
  createHostSession,
  type HostRestoreState,
  type HostSession,
} from '../../../src/features/game/network/hostSession.ts';
import { MemoryNetwork } from '../../../src/features/game/network/memoryTransport.ts';
import { hostPeerIdForRoom } from '../../../src/features/game/network/roomCode.ts';
import { LAST_CARD_GRACE_MS } from '../../../src/features/game/network/timing.ts';
import { LAST_CARD_PENALTY } from '../../../src/features/game/engine/cards.ts';
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

async function openRoom(options: { now?: () => number } = {}): Promise<Room> {
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
    ...(options.now ? { now: options.now } : {}),
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
    expect(afterFirst).toBe(before + 1);

    client.session.submitAction({ type: 'drawCard' }, 'rq-1');
    await flush();

    // Applied once, answered twice. The request id is remembered on the *seat*, so
    // it survives the reconnect that is the only reason it exists — and a replayed
    // catch is eight cards, so this is not a tidiness matter.
    expect(room.hostRecorder.last('publicState')?.state.version).toBe(afterFirst);
    const accepted = client.recorder.ofType('actionAccepted');
    expect(accepted).toHaveLength(2);
    expect(new Set(accepted.map((entry) => entry.version)).size).toBe(1);

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });

  it('answers a repeated join instead of leaving the client to time out', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    const first = client.recorder.ofType('identity').length;
    expect(first).toBe(1);

    /*
     * A client whose accept was lost re-sends `joinRequest` on the same channel.
     * The host used to return silently because the record already held a seat, so
     * the one message whose loss costs most was the one nothing recovered from —
     * and no credential was stored either, since the credential travels in it.
     */
    client.session.resendJoinForTests();
    await flush();

    expect(client.recorder.ofType('identity')).toHaveLength(2);
    const identities = client.recorder.ofType('identity');
    // The same seat, not a second one.
    expect(identities[1]?.playerId).toBe(identities[0]?.playerId);
    expect(room.host.connectedPlayerCount).toBe(2);
    expect(room.hostRecorder.last('lobby')?.lobby.players).toHaveLength(2);

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });
});

describe('a reconnect loop that has to keep going', () => {
  it('keeps trying after the first attempt fails', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    expect(client.session.localPlayerId).not.toBe('');
    const transport = room.network.get('client-1');
    expect(transport).toBeDefined();

    vi.useFakeTimers();
    try {
      // Every subsequent connect is refused, which is the state a phone is in for
      // the whole of a network handover.
      transport?.setConnectFault('unavailable');
      const before = transport?.connectAttempts ?? 0;
      client.session.forceReconnectForTests();

      await vi.advanceTimersByTimeAsync(120_000);

      /*
       * The blocker this pins: the failure path scheduled the next attempt while
       * the "a connect is in flight" flag was still set, and the scheduler declines
       * to arm a timer in that state. One attempt, then permanent silence — and the
       * give-up deadline was never reached either, because it is only consulted
       * from inside an attempt. Two minutes of backoff is many attempts.
       */
      expect((transport?.connectAttempts ?? 0) - before).toBeGreaterThan(3);
    } finally {
      vi.useRealTimers();
      client.session.destroy('leftVoluntarily');
      room.destroy();
    }
  });

  it('reports a failure the player can act on once the seat can no longer be held', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    const transport = room.network.get('client-1');

    vi.useFakeTimers();
    try {
      transport?.setConnectFault('unavailable');
      client.session.forceReconnectForTests();

      // Past the point where the host would have vacated the seat: spinning on
      // past it would be keeping a promise nobody else is keeping.
      await vi.advanceTimersByTimeAsync(400_000);
      expect(client.session.connectionPhase).toBe('failed');
    } finally {
      vi.useRealTimers();
      client.session.destroy('leftVoluntarily');
      room.destroy();
    }
  });
});

describe('a channel that stops carrying traffic', () => {
  it('notices a channel that reports itself open and carries nothing', async () => {
    /*
     * Fake timers are installed *first*, on purpose. A `setInterval` registered
     * before they are is held by the real clock and never fires under them — which
     * is a trap worth naming, because a test written the other way round appears to
     * exercise the heartbeat and in fact advances past a timer that is not there.
     */
    vi.useFakeTimers();
    try {
      const network = new MemoryNetwork();
      const hostRecorder = createRecorder();
      const host = await createHostSession({
        transport: network.create(HOST_PEER_ID),
        roomCode: TEST_ROOM,
        hostDisplayName: 'Host',
        maxPlayers: 4,
        tableLanguage: 'he',
        observer: hostRecorder.observer,
        heartbeatIntervalMs: 500,
      });
      const guestTransport = network.create('client-1');
      const client = await createClientSession({
        transport: guestTransport,
        roomCode: TEST_ROOM,
        hostPeerId: HOST_PEER_ID,
        displayName: 'Dana',
        observer: createRecorder().observer,
        heartbeatIntervalMs: 100_000,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(host.connectedPlayerCount).toBe(2);

      /*
       * The failure that matters most, and the one a naive fake cannot express: the
       * guest's channel still reports itself open, and everything it sends
       * disappears. Nobody is told anything — which is exactly what a WebRTC
       * channel does when its ICE path dies.
       */
      guestTransport.faults.blackhole = true;
      await vi.advanceTimersByTimeAsync(60_000);

      const guest = hostRecorder.last('lobby')?.lobby.players.find((player) => !player.isHost);
      expect(guest?.health).toBe('disconnected');
      expect(guest?.absentSince).toBeGreaterThan(0);

      client.destroy('leftVoluntarily');
      host.destroy('leftVoluntarily');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not promote a dead channel back to healthy after the host sleeps', async () => {
    /*
     * The regression this pins, which a fix for the opposite bug introduced.
     *
     * A late watchdog tick clears the probe record — those questions were asked into
     * a gap and their silence proves nothing. But if "no probe has gone unanswered"
     * is then read as health, a channel that is open and carrying nothing is promoted
     * to connected, its absence timer cleared, and the table freezes on a player who
     * is long gone — every time the host's own tab sleeps. Health must be an
     * *answered* probe, never merely an unrefuted one.
     */
    vi.useFakeTimers();
    try {
      const network = new MemoryNetwork();
      const hostRecorder = createRecorder();
      const host = await createHostSession({
        transport: network.create(HOST_PEER_ID),
        roomCode: TEST_ROOM,
        hostDisplayName: 'Host',
        maxPlayers: 4,
        tableLanguage: 'he',
        observer: hostRecorder.observer,
        heartbeatIntervalMs: 500,
      });
      const guestTransport = network.create('client-1');
      const client = await createClientSession({
        transport: guestTransport,
        roomCode: TEST_ROOM,
        hostPeerId: HOST_PEER_ID,
        displayName: 'Dana',
        observer: createRecorder().observer,
        heartbeatIntervalMs: 100_000,
      });
      await vi.advanceTimersByTimeAsync(10);
      // Mid-game, so the seat is held rather than swept by the lobby's short grace.
      host.startGame();
      await vi.advanceTimersByTimeAsync(10);

      guestTransport.faults.blackhole = true;
      await vi.advanceTimersByTimeAsync(60_000);
      const guestId = client.localPlayerId;
      const healthOf = (): string | undefined =>
        hostRecorder.last('lobby')?.lobby.players.find((player) => player.id === guestId)?.health;
      expect(healthOf()).toBe('disconnected');

      // Now the host's own tab sleeps: one tick, five minutes of wall clock.
      await vi.advanceTimersByTimeAsync(300_000);

      // Still gone. Nothing was heard from them in the meantime.
      expect(healthOf()).toBe('disconnected');
      const guest = hostRecorder.last('lobby')?.lobby.players.find((player) => player.id === guestId);
      expect(guest?.absentSince).toBeGreaterThan(0);

      client.destroy('leftVoluntarily');
      host.destroy('leftVoluntarily');
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a phone that loses its network silently, and a reconnect that hangs', async () => {
    /*
     * Two faults this file claimed to model and nothing drove.
     *
     * `vanish()` is a lost network rather than a closed channel: the far end is
     * never told, so the host keeps believing it has a live seat and can only find
     * out by asking. A `hang` connect is the other half of the same story — an offer
     * the broker queued and nobody answered — and it is what the reconnect deadline
     * exists for. A retry that waits for ever is indistinguishable from a client that
     * gave up, which is the shape the original bug had.
     */
    vi.useFakeTimers();
    try {
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
        heartbeatIntervalMs: 500,
      });
      const guestTransport = network.create('client-1');
      const client = await createClientSession({
        transport: guestTransport,
        roomCode: TEST_ROOM,
        hostPeerId: HOST_PEER_ID,
        displayName: 'Dana',
        observer: createRecorder().observer,
        heartbeatIntervalMs: 100_000,
      });
      await vi.advanceTimersByTimeAsync(10);
      host.startGame();
      await vi.advanceTimersByTimeAsync(10);
      const guestId = client.localPlayerId;
      const healthOf = (): string | undefined =>
        hostRecorder.last('lobby')?.lobby.players.find((player) => player.id === guestId)?.health;
      expect(healthOf()).toBe('connected');

      // Every reconnect attempt from here on hangs, so the client cannot quietly
      // repair the situation before the host has had to form an opinion about it.
      guestTransport.setConnectFault('hang');
      const attemptsBefore = guestTransport.connectAttempts;
      guestTransport.connections[0]?.vanish();
      await vi.advanceTimersByTimeAsync(60_000);

      // The host was told nothing and worked it out from unanswered probes.
      expect(healthOf()).toBe('disconnected');
      // The seat is held, not freed: this is mid-game.
      expect(hostRecorder.last('lobby')?.lobby.players).toHaveLength(2);
      /*
       * And the client is still trying rather than sitting on one dead promise. Both
       * the transport's budget and the session's own backstop are in play here: a
       * connect that never settles must not be able to freeze the retry loop, since
       * that leaves no attempt in flight, no deadline and nothing said to the player.
       */
      expect(guestTransport.connectAttempts).toBeGreaterThan(attemptsBefore + 1);

      client.destroy('leftVoluntarily');
      host.destroy('leftVoluntarily');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a duplicated action exactly once', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    const guestId = client.session.localPlayerId;
    if (room.hostRecorder.last('publicState')?.state.currentPlayerId !== guestId) {
      room.host.submitLocalAction({ type: 'drawCard' });
      await flush();
    }

    // Delivery itself duplicates every frame, as a replaying peer would.
    const transport = room.network.get('client-1');
    (transport as unknown as { faults: { duplicate?: boolean } }).faults.duplicate = true;

    const before = room.hostRecorder.last('publicState')?.state.version ?? 0;
    client.session.submitAction({ type: 'drawCard' }, 'rq-dup');
    await flush();
    const after = room.hostRecorder.last('publicState')?.state.version ?? 0;

    // One command's worth of movement, not two. The envelope dedup catches the
    // wire-level copy; the seat's request id would catch a genuine replay.
    expect(after).toBe(before + 1);

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });

  it('treats a degraded channel as recoverable rather than dead', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    await flush();
    expect(client.session.connectionPhase).toBe('connected');
    client.recorder.clear();

    // An ICE state of `disconnected` is recoverable — the agent may still
    // re-nominate a pair — so it must be probed, never closed. Waiting for
    // `failed` instead, as this once did, means waiting until the library has
    // already torn the connection down.
    client.session.degradeForTests();
    await flush();

    // It was noticed…
    const phases = client.recorder.ofType('phase').map((entry) => entry.phase);
    expect(phases).toContain('reconnecting');
    // …the channel was not closed…
    expect(client.recorder.ofType('closed')).toHaveLength(0);
    // …and because the probe was answered, the session settled back by itself.
    expect(client.session.connectionPhase).toBe('connected');

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });

  it('does not leak a seat when a client reconnects repeatedly', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    const identity = client.recorder.last('identity');
    expect(identity).toBeDefined();
    room.host.startGame();
    await flush();
    expect(room.host.connectedPlayerCount).toBe(2);

    /*
     * Three rounds of coming back on the same credential *before* the old channel
     * has gone — which is the only version of this that exercises the bug. A phone
     * that changes network does not close anything: the host is holding a channel it
     * still believes in when the replacement arrives, so it has to kick one of them
     * as a duplicate. That path used to null the record's player id, after which the
     * close handler bailed out before freeing anything, and every cycle cost a seat
     * against `maxPlayers` — a flaky phone could fill a room with its own ghosts.
     * Closing first, as this test originally did, skips the duplicate entirely.
     */
    let current = client;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const previous = current;
      // The overlap is the point of the test, so it is asserted rather than assumed:
      // the old channel is live at the instant the replacement arrives.
      expect(previous.session.connectionPhase).toBe('connected');
      current = await joinRoom(room, `client-retry-${String(cycle)}`, 'Dana', {
        playerId: identity!.playerId,
        resumeToken: identity!.resumeToken,
      });
      await flush();
      previous.session.destroy('leftVoluntarily');
      await flush();
    }

    const lobby = room.hostRecorder.last('lobby')?.lobby;
    expect(lobby?.players).toHaveLength(2);
    const guest = lobby?.players.find((player) => !player.isHost);
    expect(guest?.health).toBe('connected');
    // The same seat throughout: no cycle minted a new one, which is what the leak
    // looked like from the outside.
    expect(guest?.id).toBe(identity!.playerId);
    expect(room.host.connectedPlayerCount).toBe(2);
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
    expect(recorder.last('hand')?.cards).toHaveLength(8);

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
    /*
     * Fake timers first, so the host's watchdog interval is one they control.
     * This test previously branched on whose turn it was and asserted nothing at
     * all, because seat 0 — always the host — leads the first round: the whole
     * flagship behaviour of this work had no coverage while appearing to have some.
     */
    vi.useFakeTimers();
    try {
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
        heartbeatIntervalMs: 500,
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

      host.startGame();
      await vi.advanceTimersByTimeAsync(10);
      const guestId = client.localPlayerId;

      // Put the turn on the guest unconditionally, rather than hoping for it.
      host.submitLocalAction({ type: 'drawCard' });
      await vi.advanceTimersByTimeAsync(10);
      expect(hostRecorder.last('publicState')?.state.currentPlayerId).toBe(guestId);

      // And now they are gone, without a goodbye, on their own turn.
      client.destroy('leftVoluntarily');
      await vi.advanceTimersByTimeAsync(10);

      // Well past the twelve seconds allowed for a channel we know is closed.
      await vi.advanceTimersByTimeAsync(60_000);

      const state = hostRecorder.last('publicState')?.state;
      expect(state?.currentPlayerId).toBe(host.localPlayerId);
      // Free, except for a penalty somebody else created — there was none here.
      const skipped = hostRecorder
        .ofType('events')
        .flatMap((entry) => entry.events)
        .filter((event) => event.type === 'turnSkipped');
      expect(skipped.length).toBeGreaterThanOrEqual(1);
      expect(skipped[0]).toMatchObject({ playerId: guestId, drew: 0 });

      host.destroy('leftVoluntarily');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a breaker window that is waiting on somebody who has gone', async () => {
    vi.useFakeTimers();
    try {
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
        heartbeatIntervalMs: 500,
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
      host.startGame();
      await vi.advanceTimersByTimeAsync(10);

      /*
       * The worst stall in the game, and the one invisible to any check based on
       * whose turn it is: while a +3 is open the seat on turn is the player who
       * *played* it, and every command from every other seat is refused. If the
       * seat being waited on is away, the table is frozen and nothing about the
       * current player says so.
       */
      host.forcePlusThreeForTests(client.localPlayerId);
      await vi.advanceTimersByTimeAsync(10);
      expect(hostRecorder.last('publicState')?.state.plusThree).not.toBeNull();

      client.destroy('leftVoluntarily');
      await vi.advanceTimersByTimeAsync(30_000);

      // Resolved without waiting, and with no event naming who held a breaker.
      expect(hostRecorder.last('publicState')?.state.plusThree).toBeNull();
      const named = hostRecorder
        .ofType('events')
        .flatMap((entry) => entry.events)
        .filter((event) => event.type === 'plusThreeBroken');
      expect(named).toHaveLength(0);

      host.destroy('leftVoluntarily');
    } finally {
      vi.useRealTimers();
    }
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
    const guest = lobby?.players.find((player) => !player.isHost);
    expect(guest).toBeDefined();
    expect(guest?.health).toBe('connected');

    client.destroy('leftVoluntarily');
    host.destroy('leftVoluntarily');
    vi.useRealTimers();
  });
});

describe('waiting on somebody who is present', () => {
  it('re-broadcasts once the wait is long enough to be worth a nudge', async () => {
    /*
     * The nudge is decided from `sentAt - waitingSince`, both of them the host's own
     * readings so that clock skew between devices cancels. That made it correct and
     * unreachable at the same time: the only snapshot carrying a new `waitingSince`
     * was built in the tick that set it, so the difference every client ever saw was
     * zero, and nothing else re-broadcast the lobby while a healthy seat simply
     * thought about its move. The button shipped dead.
     */
    vi.useFakeTimers();
    try {
      let clock = 3_000_000;
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
      const client = await createClientSession({
        transport: network.create('client-1'),
        roomCode: TEST_ROOM,
        hostPeerId: HOST_PEER_ID,
        displayName: 'Dana',
        observer: createRecorder().observer,
        heartbeatIntervalMs: 100_000,
        now,
      });
      await vi.advanceTimersByTimeAsync(10);
      host.startGame();
      await vi.advanceTimersByTimeAsync(10);

      const waited = (): number => {
        const lobby = hostRecorder.last('lobby')?.lobby;
        return lobby?.waitingSince !== null && lobby?.waitingSince !== undefined && lobby.sentAt !== undefined
          ? lobby.sentAt - lobby.waitingSince
          : -1;
      };
      expect(waited()).toBe(0);

      /*
       * Several ticks per step, because the tick that follows a jump in the clock is
       * a *late* tick — the host cannot tell a suspended tab from a slow one, so it
       * judges nobody and only re-probes. The decision is taken on the ordinary tick
       * after it.
       */
      // Ten seconds is an ordinary turn. Nobody should be hurried yet.
      clock += 10_000;
      await vi.advanceTimersByTimeAsync(200);
      expect(waited()).toBeLessThan(30_000);

      clock += 25_000;
      await vi.advanceTimersByTimeAsync(200);
      expect(waited()).toBeGreaterThanOrEqual(30_000);
      expect(hostRecorder.last('lobby')?.lobby.waitingReason).toBe('turn');
      expect(hostRecorder.last('lobby')?.lobby.players.every((p) => p.health === 'connected')).toBe(true);

      // And exactly once for this turn: the lobby is not put on a cadence.
      const count = hostRecorder.ofType('lobby').length;
      await vi.advanceTimersByTimeAsync(500);
      expect(hostRecorder.ofType('lobby').length).toBe(count);

      client.destroy('leftVoluntarily');
      host.destroy('leftVoluntarily');
    } finally {
      vi.useRealTimers();
    }
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

    // The action has to be one the engine would accept, or the test proves only
    // that the engine rejects an illegal move — which it would with no pause at all.
    const guestId = client.session.localPlayerId;
    if (room.hostRecorder.last('publicState')?.state.currentPlayerId !== guestId) {
      room.host.setPaused(null);
      await flush();
      room.host.submitLocalAction({ type: 'drawCard' });
      await flush();
      room.host.setPaused(room.host.localPlayerId);
      await flush();
    }
    expect(room.hostRecorder.last('publicState')?.state.currentPlayerId).toBe(guestId);

    const versionBefore = room.hostRecorder.last('publicState')?.state.version;
    client.session.submitAction({ type: 'drawCard' }, 'rq-paused');
    await flush();
    expect(room.hostRecorder.last('publicState')?.state.version).toBe(versionBefore);
    // And the player is told the truth about why, rather than that the round ended.
    expect(client.recorder.last('actionRejected')?.code).toBe('tablePaused');

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
    let clock = 1_700_000_000_000;
    const room = await openRoom({ now: () => clock });
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    const guest = room.hostRecorder.last('lobby')?.lobby.players.find((player) => !player.isHost);
    expect(guest).toBeDefined();

    /*
     * The target has to be genuinely catchable, or the engine refuses on its own
     * and the host's policy is never consulted — which is how a test of this can
     * pass with the policy deleted. Past the head start, too, or the *other*
     * policy answers first and this proves nothing either.
     */
    room.host.forceHandForTests(guest!.id, 1);
    await flush();
    clock += LAST_CARD_GRACE_MS;
    room.host.submitLocalAction({ type: 'catchLastCard', targetId: guest!.id });
    await flush();
    expect(room.hostRecorder.last('actionRejected')).toBeUndefined();

    // Now the same player is away. Absence would otherwise convert a social rule
    // into farming: four cards an orbit off somebody whose phone is rebooting and
    // who is in no position to shout.
    room.host.forceHandForTests(guest!.id, 1);
    client.session.destroy('leftVoluntarily');
    await flush();
    clock += LAST_CARD_GRACE_MS;
    room.host.submitLocalAction({ type: 'catchLastCard', targetId: guest!.id });
    await flush();
    expect(room.hostRecorder.last('actionRejected')?.code).toBe('nothingToCatch');
    room.destroy();
  });

  /**
   * The head start a last card buys its owner.
   *
   * Enforced on the host rather than in the engine, because it is a reading of a
   * clock: a timestamp inside the engine would make a replayed command produce a
   * different game. And enforced on the host rather than in the client, because a
   * client measuring its own window is measuring from whenever its snapshot
   * happened to arrive — and from a modified client, from whenever it liked.
   */
  it('gives a player a head start on their last card before anyone may call it', async () => {
    let clock = 1_700_000_000_000;
    const room = await openRoom({ now: () => clock });
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    const guest = room.hostRecorder.last('lobby')?.lobby.players.find((player) => !player.isHost);
    room.host.forceHandForTests(guest!.id, 1);
    await flush();

    // Straight away, and again a moment before the window closes.
    room.host.submitLocalAction({ type: 'catchLastCard', targetId: guest!.id });
    await flush();
    expect(room.hostRecorder.last('actionRejected')?.code).toBe('nothingToCatch');

    clock += LAST_CARD_GRACE_MS - 1;
    room.host.submitLocalAction({ type: 'catchLastCard', targetId: guest!.id });
    await flush();
    expect(room.hostRecorder.last('actionRejected')?.code).toBe('nothingToCatch');
    // Still on one card: nothing was drawn, so nothing was charged.
    expect(
      room.hostRecorder.last('publicState')?.state.players.find((player) => player.id === guest!.id)
        ?.cardCount,
    ).toBe(1);

    // A silent player stays exposed for as long as they stay silent.
    clock += 1;
    room.hostRecorder.clear();
    room.host.submitLocalAction({ type: 'catchLastCard', targetId: guest!.id });
    await flush();
    expect(room.hostRecorder.last('actionRejected')).toBeUndefined();
    expect(
      room.hostRecorder.last('publicState')?.state.players.find((player) => player.id === guest!.id)
        ?.cardCount,
    ).toBe(1 + LAST_CARD_PENALTY);

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });

  /** Coming back down to one card buys a fresh half second, exactly as it buys a fresh declaration. */
  it('starts the head start again each time a hand returns to one card', async () => {
    let clock = 1_700_000_000_000;
    const room = await openRoom({ now: () => clock });
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    const guest = room.hostRecorder.last('lobby')?.lobby.players.find((player) => !player.isHost);
    room.host.forceHandForTests(guest!.id, 1);
    await flush();
    clock += LAST_CARD_GRACE_MS;
    room.host.submitLocalAction({ type: 'catchLastCard', targetId: guest!.id });
    await flush();
    expect(room.hostRecorder.last('actionRejected')).toBeUndefined();

    // The catch itself put them back up to five, and now they are down to one
    // again — a new card, a new window.
    room.host.forceHandForTests(guest!.id, 1);
    await flush();
    room.host.submitLocalAction({ type: 'catchLastCard', targetId: guest!.id });
    await flush();
    expect(room.hostRecorder.last('actionRejected')?.code).toBe('nothingToCatch');

    client.session.destroy('leftVoluntarily');
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
    // The seat that was *not* named is the one that has to be redirected, and it is
    // told a generation rather than an address.
    const redirected = [client, other].filter((entry) => entry.recorder.ofType('handover').length > 0);
    expect(redirected).toHaveLength(1);
    expect(redirected[0]?.recorder.last('handover')?.generation).toBe(1);
    expect(redirected[0]?.session.localPlayerId).not.toBe(successor?.playerId);

    client.session.destroy('leftVoluntarily');
    other.session.destroy('leftVoluntarily');
    room.destroy();
  });
});

describe('the turn token', () => {
  it('refuses a move computed against a turn that has moved on', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    const guestId = client.session.localPlayerId;
    room.host.submitLocalAction({ type: 'drawCard' });
    await flush();
    expect(room.hostRecorder.last('publicState')?.state.currentPlayerId).toBe(guestId);

    const version = room.hostRecorder.last('publicState')?.state.version ?? 0;
    /*
     * A move built against an older turn. Replaying a stale intent is the danger
     * the token exists for: a card that was legal three moves ago may be illegal
     * now, or already played.
     */
    client.session.submitStaleActionForTests({ type: 'drawCard' }, 'rq-stale');
    await flush();

    expect(room.hostRecorder.last('publicState')?.state.version).toBe(version);
    expect(client.recorder.last('actionRejected')?.code).toBe('notYourTurn');

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });

  it('lets an out-of-turn declaration through, token or no token', async () => {
    const room = await openRoom();
    const client = await joinRoom(room, 'client-1', 'Dana');
    room.host.startGame();
    await flush();

    // It is the host's turn, and the guest declares anyway. Gating this on a turn
    // would hand every race to whoever broke the rule, so it carries no token and
    // is judged only by the engine's own predicate.
    room.host.forceHandForTests(client.session.localPlayerId, 1);
    await flush();
    client.session.submitAction({ type: 'declareLastCard' }, 'rq-declare');
    await flush();

    expect(client.recorder.ofType('actionAccepted')).toHaveLength(1);
    expect(room.hostRecorder.last('publicState')?.state.declaredLastCard).toContain(
      client.session.localPlayerId,
    );

    client.session.destroy('leftVoluntarily');
    room.destroy();
  });
});
