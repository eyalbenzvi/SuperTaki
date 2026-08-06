import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientSession, type ClientSession } from '../../../src/features/game/network/clientSession.ts';
import {
  createHostSession,
  type HostRestoreState,
  type HostSession,
} from '../../../src/features/game/network/hostSession.ts';
import { MemoryNetwork } from '../../../src/features/game/network/memoryTransport.ts';
import type { LobbySnapshot } from '../../../src/features/game/network/protocol.ts';
import { hostPeerIdForRoom } from '../../../src/features/game/network/roomCode.ts';
import {
  IDLE_TURN_NUDGE_MS,
  STAND_IN_ABSENT_MS,
  STAND_IN_IDLE_MS,
} from '../../../src/features/game/network/timing.ts';
import { __resetLifecycleForTests } from '../../../src/lib/lifecycle.ts';
import { __resetDiagnosticsForTests } from '../../../src/lib/diagnostics.ts';
import { TEST_ROOM, createRecorder } from '../helpers/net.ts';

/**
 * Robots at a real table: the host's own authoritative path, its seat machinery,
 * its snapshot, and the two ways a seat can stop answering.
 *
 * Every robot pause is pumped by hand — the host takes its timer and its pace from
 * the options, so a whole round is a loop rather than several minutes of waiting,
 * and it is the same round every time.
 */

const HOST_PEER_ID = hostPeerIdForRoom(TEST_ROOM);

beforeEach(() => {
  __resetLifecycleForTests();
  __resetDiagnosticsForTests();
  /*
   * Fake timers, and no injected clock: the host's watchdog and `Date.now` then
   * advance together, so a jump of a minute is a minute of ordinary ticks rather
   * than one tick that looks to the watchdog like a tab waking from sleep.
   */
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface Room {
  network: MemoryNetwork;
  host: HostSession;
  recorder: ReturnType<typeof createRecorder>;
  snapshots: HostRestoreState[];
  /** Runs the robot pause that is waiting, if there is one. Returns whether it ran. */
  step(): boolean;
  /** Runs up to `limit` robot pauses. Returns how many ran. */
  run(limit?: number): number;
  /** Lets `ms` of table time pass, heartbeats and all. */
  advance(ms: number): Promise<void>;
  /** Drops a client's channel without a goodbye, as a lost network does. */
  drop(id: string, session: ClientSession): Promise<void>;
  destroy(): void;
}

async function openRoom(
  options: {
    maxPlayers?: number;
    standInEnabled?: boolean;
    seed?: number;
    /** Keep the real, human-shaped pauses — for the tests that are about them. */
    realPauses?: boolean;
  } = {},
): Promise<Room> {
  const network = new MemoryNetwork();
  const recorder = createRecorder();
  const snapshots: HostRestoreState[] = [];
  const pauses: Array<{ run: () => void; cancelled: boolean }> = [];

  const host = await createHostSession({
    transport: network.create(HOST_PEER_ID),
    roomCode: TEST_ROOM,
    hostDisplayName: 'Host',
    maxPlayers: options.maxPlayers ?? 4,
    tableLanguage: 'en',
    observer: recorder.observer,
    seedFactory: () => options.seed ?? 4242,
    heartbeatIntervalMs: 500,
    onSnapshot: (state) => snapshots.push(state),
    ...(options.standInEnabled === undefined ? {} : { standInEnabled: options.standInEnabled }),
    bot: {
      schedule: (run) => {
        const entry = { run, cancelled: false };
        pauses.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
      ...(options.realPauses === true ? {} : { pauseMs: () => 0 }),
    },
  });

  const step = (): boolean => {
    const next = pauses.find((pause) => !pause.cancelled);
    if (!next) {
      return false;
    }
    next.cancelled = true;
    next.run();
    return true;
  };

  return {
    network,
    host,
    recorder,
    snapshots,
    step,
    run(limit = 400) {
      let ran = 0;
      while (ran < limit && step()) {
        ran += 1;
      }
      return ran;
    },
    async advance(ms) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    async drop(id, session) {
      /*
       * A device that lost its network, modelled exactly: the channel goes, and the
       * transport goes with it so nothing can reconnect in the next tick. The session
       * is only torn down afterwards, when it has no live channel — a session that
       * still has one says goodbye on the way out, and a goodbye is a decision, which
       * is the opposite of the case under test.
       */
      const transport = network.get(id);
      transport?.connections.forEach((connection) => {
        connection.close();
      });
      transport?.destroy();
      await vi.advanceTimersByTimeAsync(10);
      session.destroy('leftVoluntarily');
      await vi.advanceTimersByTimeAsync(10);
    },
    destroy() {
      host.destroy('leftVoluntarily');
    },
  };
}

async function joinRoom(
  room: Room,
  id: string,
  name: string,
): Promise<{ session: ClientSession; recorder: ReturnType<typeof createRecorder> }> {
  const recorder = createRecorder();
  const session = await createClientSession({
    transport: room.network.create(id),
    roomCode: TEST_ROOM,
    hostPeerId: HOST_PEER_ID,
    displayName: name,
    observer: recorder.observer,
    heartbeatIntervalMs: 10_000_000,
  });
  await vi.advanceTimersByTimeAsync(10);
  return { session, recorder };
}

function lobbyPlayers(room: Room): LobbySnapshot['players'] {
  return room.recorder.last('lobby')?.lobby.players ?? [];
}

/** One seat as the table currently sees it. */
function seatOf(room: Room, playerId: string): LobbySnapshot['players'][number] | undefined {
  return lobbyPlayers(room).find((player) => player.id === playerId);
}

/**
 * Runs a round to its end with every seat played by a robot.
 *
 * Robots are asked first, and only when none of them owes anything does this look
 * for something a seat *cannot* answer for itself — which, with every seat covered,
 * should never happen. Failing loudly there rather than breaking out of the loop is
 * the difference between a test that proves a round finishes and one that quietly
 * asserts nothing.
 */
function playOut(room: Room, limit = 2_000): void {
  for (let guard = 0; guard < limit; guard += 1) {
    const state = room.recorder.last('publicState')?.state;
    if (!state || state.phase !== 'playing') {
      return;
    }
    if (room.step()) {
      continue;
    }
    throw new Error(
      `nothing was owed while the round was still running (turn: ${String(
        state.currentPlayerId,
      )}, +3 open: ${String(state.plusThree !== null)})`,
    );
  }
  throw new Error('the round did not finish inside the budget');
}

describe('seating a robot', () => {
  it('adds a named robot the table can see, and removes it again', async () => {
    const room = await openRoom();
    expect(room.host.addBot()).toBe(true);

    const seated = lobbyPlayers(room);
    expect(seated).toHaveLength(2);
    const robot = seated[1];
    expect(robot?.bot).toBe(true);
    expect(robot?.name).toMatch(/Robot/);
    // Always here: it has no channel to lose.
    expect(robot?.health).toBe('connected');

    room.host.removePlayer(robot?.id ?? '');
    expect(lobbyPlayers(room)).toHaveLength(1);
    room.destroy();
  });

  it('refuses to seat one when the table is full or the round has started', async () => {
    const room = await openRoom({ maxPlayers: 2 });
    expect(room.host.addBot()).toBe(true);
    expect(room.host.addBot()).toBe(false);

    room.host.startGame();
    expect(room.host.addBot()).toBe(false);
    room.destroy();
  });

  it('gives each robot a different name', async () => {
    const room = await openRoom({ maxPlayers: 4 });
    room.host.addBot();
    room.host.addBot();
    room.host.addBot();
    const names = lobbyPlayers(room).map((player) => player.name);
    expect(new Set(names).size).toBe(names.length);
    room.destroy();
  });
});

describe('a round with robots in it', () => {
  it('plays itself to a winner, with every card accounted for', async () => {
    const room = await openRoom();
    room.host.addBot();
    room.host.addBot();
    room.host.startGame();

    /*
     * Including the host's own seat, so every seat at the table is played by the same
     * policy and the round needs nothing from outside. The wait first is the point:
     * a seat that is here and answering cannot be handed to a robot on a whim, so the
     * table has to have actually been waiting on it.
     */
    await room.advance(IDLE_TURN_NUDGE_MS + 1_000);
    expect(room.host.standInNow(room.host.localPlayerId)).toBe(true);
    playOut(room);

    const state = room.recorder.last('publicState')?.state;
    expect(state?.phase).toBe('finished');
    expect(state?.winnerId).not.toBeNull();
    expect(state?.endReason).toBe('won');

    // Not one card was lost or invented on the way.
    const counts = state?.players.map((player) => player.cardCount) ?? [];
    const total = counts.reduce((sum, count) => sum + count, 0);
    expect(total + (state?.drawPileCount ?? 0) + (state?.discardCount ?? 0)).toBe(116);
    room.destroy();
  });

  it('agrees to play again, so a table of robots is not stuck on the standings', async () => {
    const room = await openRoom({ maxPlayers: 2 });
    room.host.addBot();
    room.host.startGame();

    await room.advance(IDLE_TURN_NUDGE_MS + 1_000);
    expect(room.host.standInNow(room.host.localPlayerId)).toBe(true);
    playOut(room);
    expect(room.recorder.last('lobby')?.lobby.phase).toBe('finished');

    /*
     * Nothing is published about the robots' agreement. They agree so they can never
     * block a round — but a screen that said "2 of 2 agreed" while nothing happened
     * would be telling the one person still there that everybody was ready, and then
     * waiting for them.
     */
    const votes = room.recorder.last('playAgain');
    expect(votes?.agreed).toEqual([]);
    expect(votes?.required).toBe(0);

    // The host's tap is the intent that takes their seat back, and then their vote —
    // the only one the table is actually waiting for — deals the next round.
    room.host.votePlayAgain(true);
    expect(room.recorder.last('lobby')?.lobby.phase).toBe('inGame');
    room.destroy();
  });

  it('never lets a robot be the seat the room is handed over to', async () => {
    const room = await openRoom();
    room.host.addBot();
    // The only other seat is a robot, and a robot cannot serve a room: there is no
    // device behind it, so the offer would expire with the host already gone.
    expect(room.host.successor).toBeNull();

    const guest = await joinRoom(room, 'client-1', 'Dana');
    expect(room.host.successor?.name).toBe('Dana');
    guest.session.destroy('leftVoluntarily');
    room.destroy();
  });

  it('keeps its robots across a restart of the host', async () => {
    const room = await openRoom();
    room.host.addBot();
    room.host.startGame();
    const before = room.snapshots.at(-1);
    expect(before?.seats.some((seat) => seat.bot === true)).toBe(true);
    room.destroy();

    // The same room, rebuilt on the same device from what was written down.
    const network = new MemoryNetwork();
    const recorder = createRecorder();
    const revived = await createHostSession({
      transport: network.create(HOST_PEER_ID),
      roomCode: TEST_ROOM,
      hostDisplayName: 'Host',
      maxPlayers: 4,
      tableLanguage: 'en',
      observer: recorder.observer,
      heartbeatIntervalMs: 10_000_000,
      restore: before,
      bot: { schedule: () => () => {}, pauseMs: () => 0 },
    });

    const robot = recorder.last('lobby')?.lobby.players.find((player) => player.bot === true);
    expect(robot).toBeDefined();
    // And it comes back *present*, not as a seat waiting for somebody who will
    // never arrive: there is nothing for a robot to reconnect.
    expect(robot?.health).toBe('connected');
    expect(robot?.absentSince).toBeUndefined();
    revived.destroy('leftVoluntarily');
  });
});

describe('a player who disconnects', () => {
  it('has their hand played by a robot once the table has waited long enough', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();

    // Put the turn on the guest, then take their device away.
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);
    expect(room.recorder.last('publicState')?.state.currentPlayerId).toBe(guestId);
    await room.drop('client-1', guest.session);

    // Inside the ordinary skip window nothing has changed: a blip is still a free
    // skip, which costs its owner nothing.
    await room.advance(STAND_IN_ABSENT_MS - 1_000);
    expect(room.recorder.last('lobby')?.lobby.players.some((player) => player.standIn)).toBe(false);

    await room.advance(2_000);
    const held = seatOf(room, guestId);
    expect(held?.standIn).toBe(true);
    // The table is no longer *waiting* for them, so nothing says it is holding a seat.
    expect(room.recorder.last('lobby')?.lobby.waitingReason).not.toBe('absent');

    /*
     * And the robot actually plays — once the turn is theirs. It owes nothing while
     * the table is on somebody else's turn, which is the point: a stand-in is a seat
     * being played, not a robot taking over the round.
     */
    const before = room.recorder
      .last('publicState')
      ?.state.players.find((player) => player.id === guestId)?.cardCount;
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);
    expect(room.recorder.last('publicState')?.state.currentPlayerId).toBe(guestId);
    expect(room.step()).toBe(true);
    const after = room.recorder
      .last('publicState')
      ?.state.players.find((player) => player.id === guestId)?.cardCount;
    expect(after).not.toBe(before);
    room.destroy();
  });

  it('gets their seat back the moment they come back', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    const credential = guest.recorder.last('identity');
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);

    await room.drop('client-1', guest.session);
    await room.advance(STAND_IN_ABSENT_MS + 1_000);
    expect(seatOf(room, guestId)?.standIn).toBe(true);

    const returning = await createClientSession({
      transport: room.network.create('client-1b'),
      roomCode: TEST_ROOM,
      hostPeerId: HOST_PEER_ID,
      displayName: 'Dana',
      observer: createRecorder().observer,
      heartbeatIntervalMs: 10_000_000,
      resume: { playerId: guestId, resumeToken: credential?.resumeToken ?? '' },
    });
    await room.advance(10);

    const seat = seatOf(room, guestId);
    expect(seat?.standIn).toBeUndefined();
    expect(seat?.health).toBe('connected');
    returning.destroy('leftVoluntarily');
    room.destroy();
  });

  it('is skipped and never stood in for when the table has said no', async () => {
    const room = await openRoom({ standInEnabled: false });
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);
    await room.drop('client-1', guest.session);

    await room.advance(STAND_IN_ABSENT_MS * 3);
    expect(seatOf(room, guestId)?.standIn).toBeUndefined();
    // The behaviour a table without robots has always had: the turn is passed, free.
    const skipped = room.recorder
      .ofType('events')
      .flatMap((entry) => entry.events)
      .filter((event) => event.type === 'turnSkipped');
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    room.destroy();
  });

  it('is never stood in for after saying goodbye', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);

    // A goodbye is a decision, and playing the hand of somebody who has said they
    // are done is not a favour.
    // `destroy` on a live channel says goodbye, which is exactly the case here.
    guest.session.destroy('leftVoluntarily');
    await room.advance(10);
    await room.advance(STAND_IN_ABSENT_MS * 2);
    expect(seatOf(room, guestId)?.standIn).toBeUndefined();
    room.destroy();
  });

  it('can be covered at once when the host says so', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);
    await room.drop('client-1', guest.session);

    expect(room.host.standInNow(guestId)).toBe(true);
    expect(seatOf(room, guestId)?.standIn).toBe(true);

    // And handed straight back when the host changes their mind.
    expect(room.host.stopStandIn(guestId)).toBe(true);
    expect(seatOf(room, guestId)?.standIn).toBeUndefined();
    room.destroy();
  });
});

describe('a player who is there but not answering', () => {
  it('is covered only after the table has waited, and only on real silence', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);
    expect(room.recorder.last('publicState')?.state.currentPlayerId).toBe(guestId);

    // Heartbeats keep arriving — a phone in a pocket answers those perfectly — and
    // they are not an answer to anything.
    await room.advance(STAND_IN_IDLE_MS + 1_000);
    await room.advance(10);

    const seat = seatOf(room, guestId);
    expect(seat?.health).toBe('connected');
    expect(seat?.standIn).toBe(true);
    room.destroy();
  });

  it('takes the seat straight back with its next move', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);

    await room.advance(STAND_IN_IDLE_MS + 1_000);
    await room.advance(10);
    expect(seatOf(room, guestId)?.standIn).toBe(true);

    guest.session.submitAction({ type: 'drawCard' }, 'rq-back');
    await room.advance(10);
    const seat = seatOf(room, guestId);
    expect(seat?.standIn).toBeUndefined();
    room.destroy();
  });

  it('is never covered while the table is holding', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);

    room.host.setPaused(room.host.localPlayerId);
    await room.advance(STAND_IN_IDLE_MS + 1_000);
    await room.advance(10);
    // A hold means the table has agreed to wait, which is the opposite of asking a
    // robot to press on.
    expect(seatOf(room, guestId)?.standIn).toBeUndefined();
    room.destroy();
  });
});

describe('a robot that does not move', () => {
  it('has its seat passed by the host rather than stopping the round', async () => {
    const room = await openRoom({ maxPlayers: 2 });
    room.host.addBot();
    room.host.startGame();

    // Put the turn on the robot and then never run its pause: a suspended tab, a
    // throttled timer, a bug in the driver — from the table's side they look alike.
    while (room.recorder.last('publicState')?.state.currentPlayerId === room.host.localPlayerId) {
      room.host.submitLocalAction({ type: 'drawCard' });
      await room.advance(10);
    }
    const robotId = room.recorder.last('publicState')?.state.currentPlayerId;
    expect(robotId).not.toBe(room.host.localPlayerId);

    await room.advance(60_000);
    expect(room.recorder.last('publicState')?.state.currentPlayerId).toBe(room.host.localPlayerId);
    room.destroy();
  });
});

describe('the table keeps control of its robots', () => {
  it('does not let the next heartbeat overrule a host who stopped one', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);
    await room.drop('client-1', guest.session);
    await room.advance(STAND_IN_ABSENT_MS + 1_000);
    expect(seatOf(room, guestId)?.standIn).toBe(true);

    expect(room.host.stopStandIn(guestId)).toBe(true);
    // The sweep keys on how long the seat has been away, and that does not change
    // when somebody says no — so without remembering the refusal the robot was back
    // within one heartbeat, for ever.
    await room.advance(STAND_IN_ABSENT_MS + 10_000);
    expect(seatOf(room, guestId)?.standIn).toBeUndefined();
    room.destroy();
  });

  it('leaves the way out reachable while a robot is covering a seat', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);
    await room.drop('client-1', guest.session);
    await room.advance(STAND_IN_ABSENT_MS + 1_000);

    // Taking somebody out of the round has to stay possible: their phone is dead,
    // and a covered seat is deliberately not listed as a held one.
    expect(room.host.removeFromRound(guestId)).toBe(true);
    const seat = seatOf(room, guestId);
    expect(seat?.left).toBe(true);
    expect(seat?.standIn).toBeUndefined();
    room.destroy();
  });

  it('will not hand a robot a seat that is here and answering', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);

    // One mis-tap must not take a playing player's hand off them mid-turn.
    expect(room.host.standInNow(guestId)).toBe(false);
    expect(seatOf(room, guestId)?.standIn).toBeUndefined();

    await room.advance(IDLE_TURN_NUDGE_MS + 1_000);
    expect(room.host.standInNow(guestId)).toBe(true);
    room.destroy();
  });

  it('declares at once for a seat it is only covering', async () => {
    const room = await openRoom({ realPauses: true });
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);
    await room.drop('client-1', guest.session);
    await room.advance(STAND_IN_ABSENT_MS + 1_000);
    expect(seatOf(room, guestId)?.standIn).toBe(true);

    room.host.forceHandForTests(guestId, 1);
    room.run();
    /*
     * A robot's own last card is fair game — being catchable is what keeps it a
     * player rather than an oracle. Somebody else's is not: those four cards would
     * follow their owner into the standings for a rule they were not there to keep.
     */
    expect(room.recorder.last('publicState')?.state.declaredLastCard).toContain(guestId);
    room.destroy();
  });

  it('resolves a +3 that a seat which is here has simply not answered', async () => {
    const room = await openRoom({ standInEnabled: false });
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.forcePlusThreeForTests(guestId);
    await room.advance(10);
    expect(room.recorder.last('publicState')?.state.plusThree).not.toBeNull();

    /*
     * The worst freeze there is, and the one no turn-based check can see: while a +3
     * is open the seat on turn is the player who *played* it, so a seat that answers
     * every heartbeat and taps nothing held the whole table indefinitely.
     */
    await room.advance(STAND_IN_IDLE_MS + 5_000);
    expect(room.recorder.last('publicState')?.state.plusThree).toBeNull();
    room.destroy();
  });
});

describe('a refusal belongs to the moment it was made about', () => {
  it('does not cover the same silence again after the table said no', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(STAND_IN_IDLE_MS + 1_000);
    expect(seatOf(room, guestId)?.standIn).toBe(true);

    expect(room.host.stopStandIn(guestId)).toBe(true);
    await room.advance(STAND_IN_IDLE_MS * 2);
    // The silence never ended, so nothing happened that the table has not answered.
    expect(seatOf(room, guestId)?.standIn).toBeUndefined();
    room.destroy();
  });

  it('still covers a real disconnection after a refusal about mere silence', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(STAND_IN_IDLE_MS + 1_000);
    room.host.stopStandIn(guestId);

    /*
     * "Not yet, she is only thinking" says nothing about what should happen when her
     * phone actually dies. One flag for both questions silently disarmed the second
     * for the rest of the round.
     */
    await room.drop('client-1', guest.session);
    await room.advance(STAND_IN_ABSENT_MS + 2_000);
    expect(seatOf(room, guestId)?.standIn).toBe(true);
    room.destroy();
  });

  it('lets a returning player be covered again if they go quiet a second time', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(STAND_IN_IDLE_MS + 1_000);
    room.host.stopStandIn(guestId);

    guest.session.submitAction({ type: 'drawCard' }, 'rq-back');
    await room.advance(10);
    // Their move ended their turn, so the table is waiting on the host until it plays.
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(10);
    expect(room.recorder.last('publicState')?.state.currentPlayerId).toBe(guestId);

    // They answered, so the refusal about their silence is spent with the silence.
    await room.advance(STAND_IN_IDLE_MS + 1_000);
    expect(seatOf(room, guestId)?.standIn).toBe(true);
    room.destroy();
  });

  it('remembers, in the standings, that a robot played a seat at all', async () => {
    const room = await openRoom();
    const guest = await joinRoom(room, 'client-1', 'Dana');
    const guestId = guest.session.localPlayerId;
    room.host.startGame();
    room.host.submitLocalAction({ type: 'drawCard' });
    await room.advance(STAND_IN_IDLE_MS + 1_000);
    expect(seatOf(room, guestId)?.standIn).toBe(true);

    guest.session.submitAction({ type: 'drawCard' }, 'rq-back');
    await room.advance(10);
    const seat = seatOf(room, guestId);
    // Back at the table, so no longer covered — but a round decided partly by a robot
    // reads differently from one that was not, and the result outlives the moment.
    expect(seat?.standIn).toBeUndefined();
    expect(seat?.robotPlayed).toBe(true);
    room.destroy();
  });
});
