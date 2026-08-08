/**
 * The room, driven end to end in plain Node.
 *
 * These are the tests that used to live in `tests/unit/network/sessions.test.ts` and
 * `resilience.test.ts` against `HostSession`. They moved here with the authority.
 */

import { describe, expect, it } from 'vitest';
import { Harness, type TestClient } from './harness.ts';
import { readRoom } from '../src/storage.ts';
import type { Card } from '../../src/features/game/engine/cards.ts';
import { PROTOCOL_VERSION } from '../../src/features/game/network/protocol.ts';
import {
  ABSENT_TURN_GRACE_CLOSED_MS,
  BOT_STALL_MS,
  IDLE_TURN_NUDGE_MS,
  LOBBY_GRACE_MS,
  RESUME_ATTEMPT_SUPPRESSES_SKIP_MS,
  SEAT_GRACE_MS,
  STAND_IN_ABSENT_MS,
  STAND_IN_IDLE_MS,
} from '../../src/features/game/network/timing.ts';

const CREATE = { create: { maxPlayers: 4, tableLanguage: 'he' as const } };

/** A room with two seated players and a round in play. */
function dealtTable(options?: ConstructorParameters<typeof Harness>[0]) {
  const table = new Harness(options);
  const creator = table.join('Dana', CREATE);
  const guest = table.join('Yoni');
  creator.client.say('roomCommand', { command: { type: 'startGame' } });
  return { table, creator, guest };
}

/** The hand the room last told this client it was holding. */
function handOf(client: TestClient): readonly Card[] {
  return client.hand;
}

function currentPlayerId(client: TestClient): string | null {
  return client.state?.currentPlayerId ?? null;
}

type Seat = { client: TestClient; playerId: string; resumeToken: string };

/** Lets whichever of these seats is on turn make one legal move. */
function takeTurn(seats: readonly Seat[]): void {
  const onTurn = currentPlayerId(seats[0]!.client);
  const seat = seats.find((candidate) => candidate.playerId === onTurn);
  if (seat === undefined) {
    throw new Error(`nobody recognisable is on turn (${String(onTurn)})`);
  }
  seat.client.takeTurn();
}

/** Plays until somebody wins, or until `limit` moves have gone by. */
function playOut(seats: readonly Seat[], limit = 800): void {
  for (let move = 0; move < limit; move += 1) {
    if (seats[0]!.client.state?.phase === 'finished') {
      return;
    }
    takeTurn(seats);
  }
}

describe('joining a room', () => {
  it('seats the creator, and refuses a second attempt to create the same code', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    expect(creator.client.expect('joinAccepted').payload.displayName).toBe('Dana');
    expect(creator.client.expect('joinAccepted').payload.lobby.creatorPlayerId).toBe(creator.playerId);

    const intruder = table.client('Someone');
    intruder.say('joinRequest', { displayName: 'Someone', ...CREATE });
    expect(intruder.expect('joinRejected').payload.reason).toBe('roomTaken');
    expect(intruder.closed).not.toBeNull();
  });

  it('refuses a join for a room that was never created', () => {
    const table = new Harness();
    const stranger = table.client('Lost');
    stranger.say('joinRequest', { displayName: 'Lost' });
    expect(stranger.expect('joinRejected').payload.reason).toBe('roomClosed');
  });

  it('refuses a join once the room is full, and once the round has started', () => {
    const table = new Harness();
    const creator = table.join('Dana', { create: { maxPlayers: 2, tableLanguage: 'he' } });
    table.join('Yoni');

    const third = table.client('Late');
    third.say('joinRequest', { displayName: 'Late' });
    expect(third.expect('joinRejected').payload.reason).toBe('roomFull');

    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    const fourth = table.client('Later');
    fourth.say('joinRequest', { displayName: 'Later' });
    expect(fourth.expect('joinRejected').payload.reason).toBe('gameInProgress');
  });

  it('gives two players called Dana distinguishable names', () => {
    const table = new Harness();
    table.join('Dana', CREATE);
    const second = table.join('Dana');
    expect(second.client.expect('joinAccepted').payload.displayName).not.toBe('Dana');
  });

  it('answers a repeated join on the same socket instead of going silent', () => {
    // A lost `joinAccepted` is the message whose loss costs most: the credential is
    // inside it. Retrying has to work.
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    creator.client.forget();
    creator.client.say('joinRequest', { displayName: 'Dana' });
    expect(creator.client.expect('joinAccepted').payload.playerId).toBe(creator.playerId);
    // Answered, and one seat — not answered and seated twice.
    expect(table.room.snapshotForTests().room?.seats.length).toBe(1);
  });
});

describe('resuming a seat', () => {
  it('lets a player come back with their token, and hands them their own hand', () => {
    const { table, guest } = dealtTable();
    const before = handOf(guest.client);

    table.room.handleClose(guest.client);
    const returning = table.client('Yoni-again');
    returning.say('resumeRequest', { playerId: guest.playerId, resumeToken: guest.resumeToken });

    expect(returning.expect('joinAccepted').payload.playerId).toBe(guest.playerId);
    expect(handOf(returning).map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(
      returning.expect('lobbyState').payload.lobby.players.find((p) => p.id === guest.playerId)?.health,
    ).toBe('connected');
  });

  it('refuses a wrong token, and an unknown seat', () => {
    const { table, guest } = dealtTable();
    table.room.handleClose(guest.client);

    const forger = table.client('Forger');
    forger.say('resumeRequest', { playerId: guest.playerId, resumeToken: 'f'.repeat(32) });
    expect(forger.expect('joinRejected').payload.reason).toBe('invalidResumeToken');

    const ghost = table.client('Ghost');
    ghost.say('resumeRequest', { playerId: 'pl_nobody', resumeToken: 'a'.repeat(32) });
    expect(ghost.expect('joinRejected').payload.reason).toBe('unknownSeat');
  });

  it('supersedes an older socket for the same seat, and says why', () => {
    const { table, guest } = dealtTable();
    const second = table.client('Yoni-tab2');
    second.say('resumeRequest', { playerId: guest.playerId, resumeToken: guest.resumeToken });

    expect(second.last('joinAccepted')).toBeDefined();
    expect(guest.client.closed?.code).toBe(4001);
    /*
     * The frame matters as much as the close. A bare close reads to the loser as a
     * dropped connection, so it reconnects with the same credential, supersedes the
     * winner, and the two tabs evict each other for ever. The close code alone is not
     * enough — the client's transport does not surface it.
     */
    expect(guest.client.expect('kicked').payload.reason).toBe('duplicateConnection');
  });

  it('survives a hibernation: the room comes back from storage alone', () => {
    const { table, creator, guest } = dealtTable();
    const handBefore = handOf(guest.client).map((c) => c.id);
    const versionBefore = guest.client.expect('publicState').payload.state.version;

    // Nothing in memory survives; only what was written down.
    table.hibernate();

    const returning = table.client('Yoni-after');
    returning.say('resumeRequest', { playerId: guest.playerId, resumeToken: guest.resumeToken });
    expect(handOf(returning).map((c) => c.id)).toEqual(handBefore);
    expect(returning.expect('publicState').payload.state.version).toBe(versionBefore);
    expect(returning.expect('joinAccepted').payload.lobby.creatorPlayerId).toBe(creator.playerId);
  });
});

describe('the room creator is an ordinary player', () => {
  it('can vanish mid-round and rejoin, and the round is exactly where it was', () => {
    // The whole point of the change. Under the old design this was impossible: the
    // creator's tab *was* the game, and their seat was the one seat that could not
    // be resumed.
    const { table, creator, guest } = dealtTable();
    const creatorHand = handOf(creator.client).map((c) => c.id);
    const versionBefore = guest.client.expect('publicState').payload.state.version;

    table.room.handleClose(creator.client);
    // And the object is evicted too, so nothing at all is held in memory for them.
    table.hibernate([{ socket: guest.client, playerId: guest.playerId }]);

    // The table is still there for everybody else while they are gone.
    guest.client.forget();

    const back = table.client('Dana-again');
    back.say('resumeRequest', { playerId: creator.playerId, resumeToken: creator.resumeToken });

    expect(back.expect('joinAccepted').payload.playerId).toBe(creator.playerId);
    expect(handOf(back).map((c) => c.id)).toEqual(creatorHand);
    expect(back.expect('publicState').payload.state.version).toBe(versionBefore);
    // And they still hold the lobby buttons.
    expect(back.expect('joinAccepted').payload.lobby.creatorPlayerId).toBe(creator.playerId);
  });

  it('refuses lobby commands from anybody else', () => {
    const table = new Harness();
    table.join('Dana', CREATE);
    const guest = table.join('Yoni');

    guest.client.say('roomCommand', { command: { type: 'startGame' } });
    expect(readRoom(table.store)).toMatchObject({ ok: true, value: { phase: 'lobby' } });

    guest.client.say('roomCommand', { command: { type: 'setMaxPlayers', maxPlayers: 6 } });
    expect(readRoom(table.store)).toMatchObject({ ok: true, value: { maxPlayers: 4 } });
  });

  it('passes the buttons on when the creator seat leaves the room entirely', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const first = table.join('Yoni');
    const second = table.join('Noa');

    creator.client.say('leave', {});

    // Somebody has to hold the buttons, or a table whose creator walked off in the
    // lobby could never be started by the people still sitting at it.
    expect(first.client.lobby?.creatorPlayerId).toBe(first.playerId);

    second.client.say('roomCommand', { command: { type: 'startGame' } });
    expect(second.client.last('publicState')).toBeUndefined();

    first.client.say('roomCommand', { command: { type: 'startGame' } });
    expect(first.client.last('publicState')).toBeDefined();
  });
});

describe('actions', () => {
  it('deals a round and refuses a move from the player not on turn', () => {
    const { creator, guest } = dealtTable();
    const state = creator.client.expect('publicState').payload.state;
    const offTurn = state.currentPlayerId === creator.playerId ? guest : creator;

    offTurn.client.forget();
    offTurn.client.say('action', {
      action: { type: 'drawCard' },
      requestId: 'rq-1',
    });
    expect(offTurn.client.expect('actionRejected').payload.code).toBe('notYourTurn');
  });

  it('answers a replayed requestId once, without applying it twice', () => {
    const { table, creator, guest } = dealtTable();
    const seats = [creator, guest];
    const onTurn = seats.find((s) => s.playerId === currentPlayerId(creator.client))!;

    onTurn.client.forget();
    onTurn.client.say('action', { action: { type: 'drawCard' }, requestId: 'rq-replay' });
    const firstAccept = onTurn.client.expect('actionAccepted');
    const handAfterOnce = handOf(onTurn.client).length;

    // The client lost our answer and asks again, exactly as it does after a reconnect.
    onTurn.client.forget();
    onTurn.client.say('action', { action: { type: 'drawCard' }, requestId: 'rq-replay' });
    const secondAccept = onTurn.client.expect('actionAccepted');

    expect(secondAccept.payload.version).toBe(firstAccept.payload.version);
    expect(handOf(onTurn.client).length).toBe(handAfterOnce);
    expect(table.room.snapshotForTests().game?.version).toBe(firstAccept.payload.version);
  });

  it('refuses a turn-scoped intent computed against a turn that has moved on', () => {
    const { creator, guest } = dealtTable();
    const seats = [creator, guest];
    const onTurn = seats.find((s) => s.playerId === currentPlayerId(creator.client))!;
    const staleSeq = onTurn.client.expect('publicState').payload.state.turnSeq ?? 0;

    onTurn.client.say('action', { action: { type: 'drawCard' }, requestId: 'rq-a' });
    onTurn.client.forget();
    onTurn.client.say('action', {
      action: { type: 'drawCard' },
      requestId: 'rq-b',
      turnToken: { currentPlayerId: onTurn.playerId, turnSeq: staleSeq },
    });
    expect(onTurn.client.expect('actionRejected').payload.code).toBe('notYourTurn');
  });

  it('plays a whole round to a winner', () => {
    const { creator, guest } = dealtTable();
    playOut([creator, guest]);

    const final = creator.client.state;
    expect(final?.phase).toBe('finished');
    expect(final?.winnerId).not.toBeNull();
    // The winner emptied their hand; nobody else did.
    expect(final?.players.find((p) => p.id === final.winnerId)?.cardCount).toBe(0);
    expect(creator.client.lobby?.phase).toBe('finished');
    expect(guest.client.last('playAgainState')).toBeDefined();
  });
});

describe('last card', () => {
  it('protects the head start, then exposes a silent player', () => {
    const { table, creator, guest } = dealtTable();
    table.room.forceHandForTests(guest.playerId, 1);
    creator.client.forget();

    // Inside the head start: nothing to catch yet.
    creator.client.say('action', {
      action: { type: 'catchLastCard', targetId: guest.playerId },
      requestId: 'rq-early',
    });
    expect(creator.client.expect('actionRejected').payload.code).toBe('nothingToCatch');

    // Still inside it a fifth of a second later: the window is a real head start,
    // not a frame's worth of ordering.
    table.advance(200);
    creator.client.forget();
    creator.client.say('action', {
      action: { type: 'catchLastCard', targetId: guest.playerId },
      requestId: 'rq-still-early',
    });
    expect(creator.client.expect('actionRejected').payload.code).toBe('nothingToCatch');

    table.advance(500);
    creator.client.forget();
    creator.client.say('action', {
      action: { type: 'catchLastCard', targetId: guest.playerId },
      requestId: 'rq-late',
    });
    expect(creator.client.last('actionRejected')).toBeUndefined();
    expect(creator.client.expect('actionAccepted').payload.requestId).toBe('rq-late');
    // Caught: they drew the penalty rather than sitting on one card.
    expect(handOf(guest.client).length).toBeGreaterThan(1);
  });

  it('lets a player declare, after which they cannot be caught', () => {
    const { table, creator, guest } = dealtTable();
    table.room.forceHandForTests(guest.playerId, 1);
    guest.client.say('action', { action: { type: 'declareLastCard' }, requestId: 'rq-declare' });
    table.advance(500);

    creator.client.forget();
    creator.client.say('action', {
      action: { type: 'catchLastCard', targetId: guest.playerId },
      requestId: 'rq-catch',
    });
    expect(creator.client.expect('actionRejected').payload.code).toBe('nothingToCatch');
    expect(handOf(guest.client).length).toBe(1);
  });

  it('will not let an absent player be caught for staying silent', () => {
    const { table, creator, guest } = dealtTable();
    table.room.forceHandForTests(guest.playerId, 1);
    table.advance(500);
    table.room.handleClose(guest.client);

    creator.client.forget();
    creator.client.say('action', {
      action: { type: 'catchLastCard', targetId: guest.playerId },
      requestId: 'rq-farm',
    });
    expect(creator.client.expect('actionRejected').payload.code).toBe('nothingToCatch');
  });
});

describe('absence, on the alarm', () => {
  it('passes the turn of a player who is not there, once the grace has run out', () => {
    const { table, creator, guest } = dealtTable();
    const seats = [creator, guest];
    /*
     * Play on until the seat on turn owes a plain turn and nothing else. Two states
     * reach the same place by another route and would not exercise the price of a
     * pass: a sequence of the seat's own is *closed* first, and a close that ends
     * the turn is a move rather than a pass, so it costs nothing; and an outstanding
     * +2 run is paid in full, which is somebody else's arithmetic, not this one's.
     */
    let onTurn = seats.find((s) => s.playerId === currentPlayerId(creator.client))!;
    for (let guard = 0; guard < 20; guard += 1) {
      const state = creator.client.state;
      if (state?.takiMode === null && state.pendingDraw === 0 && onTurn.playerId === guest.playerId) {
        break;
      }
      takeTurn(seats);
      onTurn = seats.find((s) => s.playerId === currentPlayerId(creator.client))!;
    }
    const away = onTurn;
    const watcher = away.playerId === creator.playerId ? guest : creator;

    const cardsBefore = watcher.client.state?.players.find((p) => p.id === away.playerId)?.cardCount;

    table.room.handleClose(away.client);
    watcher.client.forget();

    // Nothing yet: the grace is what makes a blip survivable.
    table.advance(ABSENT_TURN_GRACE_CLOSED_MS - 2_000);
    expect(currentPlayerId(watcher.client)).toBe(away.playerId);

    table.advance(4_000);
    expect(currentPlayerId(watcher.client)).not.toBe(away.playerId);
    /*
     * And it cost them exactly what the turn would have cost them: the card a
     * present player takes when they play nothing. A pass that cost nothing made a
     * dropped connection the cheapest turn at the table — a hand that cannot grow
     * cannot lose — so being orbited while away was better than sitting down.
     */
    expect(watcher.client.state?.players.find((p) => p.id === away.playerId)?.cardCount).toBe(
      (cardsBefore ?? 0) + 1,
    );
  });

  it('defers a pending skip when the seat is visibly trying to come back', () => {
    /*
     * The flapping-connection case: a phone on a train that reconnects and drops
     * again. An observed rejoin is far stronger evidence that somebody is coming back
     * than silence is that they are not, so the deadline moves out rather than the
     * turn being passed under them.
     */
    const { table, creator, guest } = dealtTable();
    const seats = [creator, guest];
    let onTurn = seats.find((s) => s.playerId === currentPlayerId(creator.client))!;
    if (onTurn.playerId === creator.playerId) {
      takeTurn(seats);
      onTurn = seats.find((s) => s.playerId === currentPlayerId(creator.client))!;
    }
    const away = onTurn;
    const watcher = away.playerId === creator.playerId ? guest : creator;
    table.room.handleClose(away.client);

    table.advance(ABSENT_TURN_GRACE_CLOSED_MS - 3_000);
    // They get back for a moment, and the tunnel takes them again.
    const flapping = table.client('coming-back');
    flapping.say('resumeRequest', { playerId: away.playerId, resumeToken: away.resumeToken });
    table.room.handleClose(flapping);

    watcher.client.forget();
    table.advance(5_000);
    // Past the original deadline, and their turn is still theirs.
    expect(currentPlayerId(watcher.client)).toBe(away.playerId);

    // But not for ever: the deferral is a window, not a veto.
    table.advance(RESUME_ATTEMPT_SUPPRESSES_SKIP_MS + 5_000);
    expect(currentPlayerId(watcher.client)).not.toBe(away.playerId);
  });

  it('frees a lobby seat once its short grace expires', () => {
    const table = new Harness();
    table.join('Dana', CREATE);
    const guest = table.join('Yoni');
    table.room.handleClose(guest.client);

    table.advance(LOBBY_GRACE_MS + 5_000);
    const stored = readRoom(table.store);
    expect(stored.ok && stored.value.seats.length).toBe(1);
  });

  it('holds a mid-round seat far longer than a lobby one', () => {
    const { table, guest } = dealtTable();
    table.room.handleClose(guest.client);
    table.advance(LOBBY_GRACE_MS + 5_000);

    // Still seated: their cards are in play and their credential still works.
    const back = table.client('Yoni-back');
    back.say('resumeRequest', { playerId: guest.playerId, resumeToken: guest.resumeToken });
    expect(back.last('joinAccepted')).toBeDefined();
  });

  it('offers the nudge once the table has waited on a present player', () => {
    const { table, creator, guest } = dealtTable();
    creator.client.forget();
    guest.client.forget();
    table.advance(IDLE_TURN_NUDGE_MS + 2_000);

    const waited = creator.client.all('lobbyState').filter((m) => {
      const lobby = m.payload.lobby;
      return (
        lobby.waitingReason === 'turn' &&
        lobby.waitingSince !== null &&
        lobby.sentAt - lobby.waitingSince >= IDLE_TURN_NUDGE_MS
      );
    });
    /*
     * Exactly one. `toBeGreaterThan(0)` was the original assertion and it is the
     * reason the loop below went unnoticed: the nudge threshold is crossed once, so
     * anything above one snapshot is the room re-offering something already offered.
     */
    expect(waited.length).toBe(1);
  });

  it('does not wake once a second while somebody thinks about a card', () => {
    /*
     * The nudge deadline is `waitingSince + IDLE_TURN_NUDGE_MS`, and `waitingSince`
     * only moves when somebody actually plays. Recomputed after the nudge has fired it
     * is a moment in the past, and `book` floors a past deadline at `now + 1 s` — so
     * booking it unconditionally means: fire, broadcast the lobby, re-book one second
     * out, for as long as the player thinks.
     *
     * At 1 Hz a single table spends 86,400 requests a day, which is most of the free
     * plan's allowance, never hibernates, and re-renders every client every second.
     * The bound here is what the cost claim in the README actually rests on.
     *
     * Stand-ins are switched off, which is a table setting any creator can choose. With
     * them on a robot takes the seat at `STAND_IN_IDLE_MS` and plays the round out, so
     * the wakes after that point are a robot legitimately playing cards. With them off
     * there is nothing left that should ever wake this room again.
     */
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const guest = table.join('Yoni');
    creator.client.say('roomCommand', { command: { type: 'setStandInEnabled', enabled: false } });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    creator.client.forget();
    guest.client.forget();

    table.wakes = 0;
    table.advance(10 * 60 * 1000);

    expect(table.wakes).toBe(1);
    expect(guest.client.all('lobbyState').length).toBe(1);
    // And the row is gone, rather than sitting one second out for ever.
    expect(table.pendingAlarms().map((entry) => entry.kind)).not.toContain('idleNudge');
  });

  it('does not wake once a second for a mid-round seat whose hold has expired', () => {
    /*
     * The same shape, on the other deadline that does not advance: a seat's grace is
     * `absentSince + SEAT_GRACE_MS`, and mid-round `sweepSeatGrace` deliberately does
     * nothing — the seat's cards are in play, so the expiry only makes it droppable
     * when the round ends, which `maybeStartNextRound` checks for itself. A handler
     * that changes nothing plus a deadline that never moves is a loop.
     */
    const table = new Harness();
    const creator = table.join('Dana', { create: { maxPlayers: 3, tableLanguage: 'en' } });
    const guest = table.join('Eli');
    const third = table.join('Noa');
    creator.client.say('roomCommand', { command: { type: 'setStandInEnabled', enabled: false } });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    table.room.handleClose(third.client);

    table.wakes = 0;
    table.advance(SEAT_GRACE_MS + 10 * 60 * 1000);

    // A handful: the absent seat's turn comes round and is passed. Not hundreds.
    expect(table.wakes).toBeLessThan(60);
    expect(guest.client.all('lobbyState').length).toBeLessThan(60);
  });

  it('books one platform alarm for many deadlines, always at the earliest', () => {
    const { table, guest } = dealtTable();
    table.room.handleClose(guest.client);

    const pending = table.pendingAlarms();
    // Several different deadlines are live at once — that is the whole reason the
    // multiplexer exists, since the object only gets one alarm.
    expect(pending.length).toBeGreaterThan(1);
    expect(table.armedAt).toBe(pending[0]!.at);
    // And none of them is booked in the past, whatever the arithmetic produced.
    expect(pending.every((entry) => entry.at > table.now())).toBe(true);
  });

  it('wakes for the earliest of several deadlines, not the last one considered', () => {
    /*
     * A +3 can be waiting on more than one seat, and each contributes a deadline. The
     * queue holds one row per kind, so a loop that books inside it lets whichever seat
     * happens to be last in the array decide when the room wakes — which is the wrong
     * seat roughly half the time, and unboundedly wrong when their clocks differ.
     */
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const second = table.join('Yoni');
    const third = table.join('Noa');
    creator.client.say('roomCommand', { command: { type: 'startGame' } });

    /*
     * Two seats owe an answer and they owe it on different clocks: one is gone, which is
     * declined for at once, and one is here and silent, which is waited out for
     * `STAND_IN_IDLE_MS`. The gone one is listed *first*, so a loop that books inside
     * itself — letting whichever seat is last decide — lands ninety seconds late.
     *
     * `armedAt === pending[0].at` is what this used to assert, and it proves nothing:
     * the mux holds one row per kind and always arms at the minimum of what it holds, so
     * it is true however wrong the row is. The row itself is the thing to check.
     */
    table.room.handleClose(third.client);
    table.room.forcePlusThreeForTests(creator.playerId, third.playerId, second.playerId);

    const at = table.room.alarmAtForTests('absentTurn');
    expect(at).not.toBeNull();
    expect(at).toBeLessThan(table.now() + STAND_IN_IDLE_MS);
    expect(table.armedAt).toBe(at);

    /*
     * And the seat it fires for is the gone one, on its own deadline, rather than both
     * of them waiting ninety seconds on the silent one. The window itself stays open —
     * `second` still owes an answer — which is exactly the point: one seat's obligation
     * is settled without the other's clock being borrowed for it.
     */
    table.advance(5_000);
    const window = table.room.snapshotForTests().game?.plusThree;
    expect(window?.awaiting).toEqual([second.playerId]);
  });

  it('resolves a +3 window that is waiting on a seat which is not there', () => {
    /*
     * The worst stall in the game: while a +3 is open the seat on turn is the player who
     * *played* it, so every command from every other seat is refused and nothing about
     * the current player says the table is frozen. If the seats being waited on are
     * away, only this deadline unfreezes it.
     */
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const second = table.join('Yoni');
    creator.client.say('roomCommand', { command: { type: 'setStandInEnabled', enabled: false } });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    table.room.handleClose(second.client);
    table.room.forcePlusThreeForTests(creator.playerId, second.playerId);
    expect(table.room.snapshotForTests().game?.plusThree).not.toBeNull();

    table.advance(ABSENT_TURN_GRACE_CLOSED_MS + 5_000);

    expect(table.room.snapshotForTests().game?.plusThree).toBeNull();
  });

  it('resolves a +3 window a present seat has simply not answered', () => {
    // The same freeze, from a phone that answers every probe and taps nothing. A
    // turn-based check cannot see this one at all.
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const second = table.join('Yoni');
    creator.client.say('roomCommand', { command: { type: 'setStandInEnabled', enabled: false } });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    table.room.forcePlusThreeForTests(creator.playerId, second.playerId);

    table.advance(STAND_IN_IDLE_MS + 5_000);

    expect(table.room.snapshotForTests().game?.plusThree).toBeNull();
  });

  it('stops working the table when nobody is connected at all', () => {
    // Two players closing their tabs must not leave the room passing turns between
    // two empty chairs every twelve seconds for six hours. The table waits.
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(creator.client);
    table.room.handleClose(guest.client);

    expect(table.pendingAlarms().map((entry) => entry.kind)).toEqual(['ttl']);

    const versionBefore = table.room.snapshotForTests().game?.version;
    table.advance(60 * 60 * 1000);
    expect(table.room.snapshotForTests().game?.version).toBe(versionBefore);
  });
});

describe('pause, abandon and play again', () => {
  it('holds the table, refuses moves while held, and lets go', () => {
    const { table, creator, guest } = dealtTable();
    const seats = [creator, guest];
    const onTurn = seats.find((s) => s.playerId === currentPlayerId(creator.client))!;

    guest.client.say('pauseRequest', { paused: true });
    expect(creator.client.expect('paused').payload.pausedBy).toBe(guest.playerId);

    onTurn.client.forget();
    onTurn.client.say('action', { action: { type: 'drawCard' }, requestId: 'rq-held' });
    expect(onTurn.client.expect('actionRejected').payload.code).toBe('tablePaused');

    guest.client.say('pauseRequest', { paused: false });
    onTurn.client.forget();
    onTurn.client.say('action', { action: { type: 'drawCard' }, requestId: 'rq-free' });
    expect(onTurn.client.expect('actionAccepted').payload.requestId).toBe('rq-free');
  });

  it('ends the round when everybody present agrees to abandon it', () => {
    const { creator, guest } = dealtTable();
    creator.client.say('abandonVote', { agree: true });
    expect(creator.client.expect('publicState').payload.state.phase).toBe('playing');

    guest.client.say('abandonVote', { agree: true });
    const final = creator.client.expect('publicState').payload.state;
    expect(final.phase).toBe('finished');
    expect(final.endReason).toBe('abandoned');
    expect(final.winnerId).toBeNull();
  });

  it('does not brick itself when a finished table loses a player for good', () => {
    /*
     * The standings had no exit but a round starting, a round needs two seats, and every
     * join was answered `gameInProgress` — so a two-player table that finished a round
     * and then lost one player showed the other "1 of 1 agreed" for six hours, with no
     * way to deal, no way to drop the empty seat, and nobody able to join and fix it.
     */
    const { table, creator, guest } = dealtTable();
    creator.client.say('abandonVote', { agree: true });
    guest.client.say('abandonVote', { agree: true });
    expect(table.room.snapshotForTests().room?.phase).toBe('finished');

    guest.client.say('leave', {});

    // The seat is gone, and one person at an empty table is in a lobby again.
    const record = table.room.snapshotForTests().room;
    expect(record?.seats.map((seat) => seat.name)).toEqual(['Dana']);
    expect(record?.phase).toBe('lobby');
    // Which is what makes it fixable: somebody can now join and they can play.
    const third = table.join('Noa');
    expect(third.client.last('joinAccepted')).toBeDefined();
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    expect(creator.client.expect('publicState').payload.state.phase).toBe('playing');
  });

  it('frees a finished table of a seat that never came back', () => {
    // The same recovery, reached by the grace running out rather than by a goodbye.
    const { table, creator, guest } = dealtTable();
    creator.client.say('abandonVote', { agree: true });
    guest.client.say('abandonVote', { agree: true });
    table.room.handleClose(guest.client);

    table.advance(SEAT_GRACE_MS + 5_000);

    const record = table.room.snapshotForTests().room;
    expect(record?.seats.map((seat) => seat.name)).toEqual(['Dana']);
    expect(record?.phase).toBe('lobby');
    // And it settled: no deadline left to wake for, rather than a sweep every second.
    expect(table.pendingAlarms().map((entry) => entry.kind)).not.toContain('seatGrace');
  });

  it('deals another round once everybody agrees to play again', () => {
    const { creator, guest } = dealtTable();
    creator.client.say('abandonVote', { agree: true });
    guest.client.say('abandonVote', { agree: true });

    creator.client.forget();
    guest.client.forget();
    creator.client.say('playAgainVote', { agree: true });
    expect(creator.client.expect('playAgainState').payload.agreed).toEqual([creator.playerId]);
    guest.client.say('playAgainVote', { agree: true });

    expect(creator.client.expect('lobbyState').payload.lobby.phase).toBe('inGame');
    expect(creator.client.expect('publicState').payload.state.phase).toBe('playing');
    // A fresh deal, not the old table.
    expect(handOf(creator.client).length).toBe(8);
  });
});

describe('robots', () => {
  it('seats a robot, and the robot plays a round out against a person', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    creator.client.say('roomCommand', { command: { type: 'addBot' } });
    expect(creator.client.lobby?.players.filter((p) => p.bot).length).toBe(1);

    creator.client.say('roomCommand', { command: { type: 'startGame' } });

    for (let move = 0; move < 400; move += 1) {
      if (creator.client.state?.phase === 'finished') {
        break;
      }
      if (creator.client.state?.currentPlayerId === creator.playerId) {
        creator.client.takeTurn();
      } else {
        // The robot moves on an alarm, like everything else the room does alone.
        table.advance(5_000);
      }
    }
    expect(creator.client.state?.phase).toBe('finished');
    expect(creator.client.state?.winnerId).not.toBeNull();
  });

  it('lets a robot cover a seat nobody has answered for in a long time', () => {
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(guest.client);
    creator.client.forget();

    table.advance(STAND_IN_ABSENT_MS + 5_000);
    const lobby = creator.client.expect('lobbyState').payload.lobby;
    const covered = lobby.players.find((p) => p.id === guest.playerId);
    expect(covered, 'the covered seat is still in the roster').toBeDefined();
    expect(covered?.standIn).toBe(true);
  });

  it('hands the seat straight back the moment its owner speaks', () => {
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(guest.client);
    table.advance(STAND_IN_ABSENT_MS + 5_000);

    const back = table.client('Yoni-back');
    back.say('resumeRequest', { playerId: guest.playerId, resumeToken: guest.resumeToken });
    const lobby = back.expect('joinAccepted').payload.lobby;
    const seat = lobby.players.find((p) => p.id === guest.playerId);
    // Found *and* uncovered: an optional chain alone passes if the seat has gone.
    expect(seat, 'the seat is still theirs').toBeDefined();
    expect(seat?.standIn).toBeUndefined();
  });
});

describe('privacy', () => {
  it('never sends one player a card id from another hand or from the draw pile', () => {
    /*
     * The invariant, asserted where the frames are rather than against a projection.
     * Every byte the room sent each client is searched for every card that was secret
     * from them at the time — the other hands *and* the order of the draw pile, which
     * is the deal itself and worth as much to see as anybody's cards.
     *
     * The sweep used to stop at `phase === 'finished'` before checking, so the frames
     * produced by the winning move — the last snapshot, the last hands, the end-of-round
     * events, the standings — were the one set never examined. That is the most
     * plausible place in the game for a full-hand reveal to be introduced.
     */
    const { table, creator, guest } = dealtTable();
    const seats = [creator, guest];
    let moves = 0;

    const sweep = (): void => {
      const game = table.room.snapshotForTests().game;
      expect(game).not.toBeNull();
      const pile = game!.drawPile.map((card) => card.id);

      for (const seat of seats) {
        const mine = new Set((game!.hands[seat.playerId] ?? []).map((card) => card.id));
        const secret = [
          ...seats
            .filter((other) => other.playerId !== seat.playerId)
            .flatMap((other) => (game!.hands[other.playerId] ?? []).map((card) => card.id)),
          ...pile,
          // A card can legitimately appear in a frame once it is the visible discard
          // top, and a player's own cards are theirs to be sent.
        ].filter((id) => !mine.has(id));

        for (const frame of seat.client.rawFrames) {
          for (const id of secret) {
            expect(frame.includes(id), `${seat.client.label} was sent ${id}`).toBe(false);
          }
        }
      }
    };

    for (let move = 0; move < 900; move += 1) {
      sweep();
      if (creator.client.state?.phase === 'finished') {
        break;
      }
      for (const seat of seats) {
        seat.client.forget();
      }
      takeTurn(seats);
      moves += 1;
      // Robots and deadlines get their turn too, so the sweep covers alarm-driven
      // broadcasts and not only the ones a move caused.
      table.advance(100);
    }

    /*
     * And it actually played a round. Without this the test passes having examined
     * almost nothing if a seed change or a deal bug ends the round on move two.
     */
    expect(creator.client.state?.phase).toBe('finished');
    expect(moves).toBeGreaterThan(10);
  });

  it('sends a hand only to the socket that owns the seat', () => {
    const { creator, guest } = dealtTable();
    for (const hand of creator.client.all('privateHand')) {
      expect(hand.payload.hand.playerId).toBe(creator.playerId);
    }
    const hands = guest.client.all('privateHand');
    expect(hands.length, 'the seat was sent a hand at all').toBeGreaterThan(0);
    for (const hand of hands) {
      expect(hand.payload.hand.playerId).toBe(guest.playerId);
    }
  });
});

describe('storage', () => {
  it('treats an unreadable room record as no room at all', () => {
    const table = new Harness();
    table.join('Dana', CREATE);
    table.store.put('room', '{"phase":"nonsense"');

    table.hibernate();
    const stranger = table.client('Lost');
    stranger.say('joinRequest', { displayName: 'Lost' });
    expect(stranger.expect('joinRejected').payload.reason).toBe('roomClosed');
    // And the damaged bytes are gone rather than re-read on the next wake, so the code
    // is usable again rather than poisoned for the lifetime of the object.
    expect(table.store.get('room')).toBeUndefined();
    expect(table.store.get('game')).toBeUndefined();
    const fresh = table.client('Fresh');
    fresh.say('joinRequest', { displayName: 'Fresh', ...CREATE });
    expect(fresh.expect('joinAccepted').payload.lobby.phase).toBe('lobby');
  });

  it('tells a socket that woke to an unreadable room, instead of ignoring it for ever', () => {
    /*
     * A seat that survived a hibernation into a room that no longer parses is seated as
     * far as it knows, and every move it makes would be dropped with nothing on screen
     * to explain it. It has to be told — which is what the room's own comment about
     * discarding a bad record has always claimed happened, and did not.
     */
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    table.join('Yoni');
    table.store.put('room', '{"phase":"nonsense"');
    creator.client.forget();

    table.hibernate([{ socket: creator.client, playerId: creator.playerId }]);

    expect(creator.client.expect('roomClosed').payload.reason).toBe('roomClosed');
    expect(creator.client.closed).not.toBeNull();
  });

  it('falls back to the lobby when the round cannot be read but the seats can', () => {
    const { table, guest } = dealtTable();
    table.store.put('game', 'not json at all');
    table.hibernate();

    const back = table.client('Yoni-back');
    back.say('resumeRequest', { playerId: guest.playerId, resumeToken: guest.resumeToken });
    // Their seat and credential survived; the round did not, so the table can deal again.
    expect(back.expect('joinAccepted').payload.lobby.phase).toBe('lobby');
  });

  it('asks to be forgotten once nobody has been here for the whole TTL', () => {
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(creator.client);
    table.room.handleClose(guest.client);

    // Well inside the TTL: the room is still there, and a credential still works.
    table.advance(60 * 60 * 1000);
    const early = table.client('Yoni-soon');
    early.say('resumeRequest', { playerId: guest.playerId, resumeToken: guest.resumeToken });
    expect(early.last('joinAccepted')).toBeDefined();
    table.room.handleClose(early);

    // Six hours of nobody, and the room asks the adapter to delete it.
    table.advance(6 * 60 * 60 * 1000 + 60_000);
    expect(table.forgotten).toBe(true);
  });

  it('is not kept alive by frames it refuses', () => {
    /*
     * The deletion deadline used to be re-derived from `now` on every write, and every
     * inbound frame causes a write — including a frame the room *rejects*. So somebody
     * mistyping the code, or anything walking the six-digit space, pushed the deadline
     * out indefinitely and the hands stayed in storage for ever.
     *
     * Six hours is not a detail: it is the entire concession the threat model offers in
     * exchange for the room holding every hand in the first place.
     */
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(creator.client);
    table.room.handleClose(guest.client);

    table.advance(5 * 60 * 60 * 1000 + 59 * 60 * 1000);
    // A stranger on the wrong room code, once a minute for the last minute of the TTL.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const stranger = table.client(`stranger-${attempt}`);
      stranger.say('joinRequest', { displayName: 'Nobody' });
      expect(stranger.expect('joinRejected').payload.reason).toBe('gameInProgress');
      table.advance(1_000);
    }

    table.advance(2 * 60 * 1000);
    expect(table.forgotten).toBe(true);
  });
});

describe('what the socket refuses', () => {
  it('drops an oversized frame without parsing it, and treats it as a departure', () => {
    const { table, creator, guest } = dealtTable();
    creator.client.forget();

    table.room.handleMessage(guest.client, 'x'.repeat(200_000));

    expect(guest.client.closed?.reason).toBe('frame too large');
    /*
     * And the seat is marked away. Closing the socket while deleting the connection by
     * hand looked equivalent and was not: the runtime's own close event then found
     * nothing, so the seat kept `absentSince: null` — no countdown for the others, no
     * grace sweep, no robot to cover it, and the seat held for ever.
     */
    expect(
      table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.absentSince,
    ).not.toBeNull();
    expect(creator.client.all('lobbyState').length).toBeGreaterThan(0);
  });

  it('drops a malformed frame the same way', () => {
    const { table, guest } = dealtTable();
    table.room.handleMessage(guest.client, '{not json');
    expect(guest.client.closed?.reason).toBe('malformed frame');
    expect(
      table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.absentSince,
    ).not.toBeNull();
  });

  it('tells a tab on an older bundle to reload rather than dropping it silently', () => {
    // A silent drop reads as a network fault, and the player sits watching a spinner
    // instead of reloading the page that would fix it.
    const table = new Harness();
    const stale = table.client('Stale');
    table.room.handleMessage(
      stale,
      JSON.stringify({
        protocolVersion: 1,
        id: 'aaaaaaaaaaaaaaaa',
        roomId: table.roomCode,
        senderPeerId: 'stale',
        timestamp: table.now(),
        type: 'joinRequest',
        payload: { displayName: 'Stale' },
      }),
    );
    expect(stale.expect('joinRejected').payload.reason).toBe('protocolMismatch');
  });

  it('ignores a frame addressed to another room, and a replayed envelope', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const stranger = table.client('Elsewhere');

    const frame = (roomId: string, id: string): string =>
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        id,
        roomId,
        senderPeerId: 'elsewhere',
        timestamp: table.now(),
        type: 'joinRequest',
        payload: { displayName: 'Elsewhere' },
      });

    table.room.handleMessage(stranger, frame('999999', 'bbbbbbbbbbbbbbbb'));
    expect(stranger.received.length).toBe(0);
    expect(table.room.snapshotForTests().room?.seats.length).toBe(1);

    // The same envelope id twice: the second is dropped before it reaches a handler.
    table.room.handleMessage(stranger, frame(table.roomCode, 'cccccccccccccccc'));
    expect(stranger.all('joinAccepted').length).toBe(1);
    table.room.handleMessage(stranger, frame(table.roomCode, 'cccccccccccccccc'));
    expect(stranger.all('joinAccepted').length).toBe(1);
    expect(table.room.snapshotForTests().room?.seats.length).toBe(2);
  });

  it('ignores an action from a socket that never joined', () => {
    const { table } = dealtTable();
    const outsider = table.client('Outsider');
    const versionBefore = table.room.snapshotForTests().game?.version;

    outsider.say('action', { action: { type: 'drawCard' } });

    expect(table.room.snapshotForTests().game?.version).toBe(versionBefore);
    expect(outsider.received.length).toBe(0);
  });
});

describe('the lobby powers', () => {
  it('will not remove the seat that holds them', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    table.join('Yoni');

    creator.client.say('roomCommand', { command: { type: 'kickPlayer', playerId: creator.playerId } });

    expect(table.room.snapshotForTests().room?.seats.map((s) => s.name)).toEqual(['Dana', 'Yoni']);
  });

  it('will not remove anybody once the cards are dealt', () => {
    // Removing a seat mid-round would freeze its hand out of play behind the table's
    // back. `removeFromRound` is the mid-round instrument, and it says so.
    const { table, creator, guest } = dealtTable();
    creator.client.say('roomCommand', { command: { type: 'kickPlayer', playerId: guest.playerId } });
    expect(table.room.snapshotForTests().room?.seats.length).toBe(2);
  });

  it('refuses a table size below the number of people already sitting at it', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    table.join('Yoni');
    table.join('Noa');

    creator.client.say('roomCommand', { command: { type: 'setMaxPlayers', maxPlayers: 2 } });

    expect(table.room.snapshotForTests().room?.maxPlayers).toBe(4);
  });

  it('will not deal to one player', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    expect(table.room.snapshotForTests().room?.phase).toBe('lobby');
    expect(table.room.snapshotForTests().game).toBeNull();
  });

  it('refuses to pass the turn of a player who is here', () => {
    /*
     * The seat *on turn*, which is the only seat this can be asked about meaningfully.
     * Naming the other one made the test unfalsifiable: the engine refuses `skipTurn`
     * for a seat that is not on turn anyway, so the assertion held whether or not the
     * room's own presence check existed. The twin test below it had the same shape and
     * did test something, which is how this one hid.
     */
    const { table, creator, guest } = dealtTable();
    const onTurn = [creator, guest].find((seat) => seat.playerId === creator.client.state?.currentPlayerId);
    expect(onTurn, 'somebody recognisable is on turn').toBeDefined();

    const versionBefore = table.room.snapshotForTests().game?.version;
    creator.client.say('roomCommand', { command: { type: 'skipAbsentTurn', playerId: onTurn!.playerId } });
    expect(table.room.snapshotForTests().game?.version).toBe(versionBefore);
  });

  it('refuses to take a present player out of the round', () => {
    /*
     * The guard `standInNow` has and this did not. The control is offered from a notice
     * about somebody the table is waiting for, so without it one mis-tap ends a
     * connected player's round mid-turn — and at two players, ends the round.
     */
    const { table, creator, guest } = dealtTable();
    creator.client.say('roomCommand', { command: { type: 'removeFromRound', playerId: guest.playerId } });

    expect(table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.left).toBe(false);
    expect(table.room.snapshotForTests().game?.phase).toBe('playing');
  });

  it('takes an absent player out of the round when asked', () => {
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(guest.client);

    creator.client.say('roomCommand', { command: { type: 'removeFromRound', playerId: guest.playerId } });

    expect(table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.left).toBe(true);
  });
});

describe('standing in for a human', () => {
  it('hands every covered seat back when the table switches it off', () => {
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(guest.client);
    table.advance(STAND_IN_ABSENT_MS + 5_000);
    expect(table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.standIn).toBe('absent');

    creator.client.say('roomCommand', { command: { type: 'setStandInEnabled', enabled: false } });

    expect(table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.standIn).toBeNull();
    // And it stays off: the sweep does not put one back on the next deadline.
    table.advance(STAND_IN_ABSENT_MS * 2);
    expect(table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.standIn).toBeNull();
  });

  it('refuses to hand a robot the seat of somebody who is here and answering', () => {
    // "Let a robot play" needs the table to have actually been waiting on that player.
    const { table, creator, guest } = dealtTable();
    creator.client.say('roomCommand', { command: { type: 'standInNow', playerId: guest.playerId } });
    expect(table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.standIn).toBeNull();
  });

  it('honours a stop, rather than undoing it on the next sweep', () => {
    /*
     * A covered seat is deliberately not offered the absent-seat controls, so if a
     * restart were allowed the table would have no way to stop a robot at all.
     */
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(guest.client);
    table.advance(STAND_IN_ABSENT_MS + 5_000);

    creator.client.say('roomCommand', { command: { type: 'stopStandIn', playerId: guest.playerId } });
    expect(table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.standIn).toBeNull();

    table.advance(STAND_IN_ABSENT_MS * 3);
    expect(table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.standIn).toBeNull();
  });

  it('never plays the hand of somebody who said goodbye', () => {
    // That was a decision, and playing the cards of somebody who has left is not a
    // favour to them.
    const { table, guest } = dealtTable();
    guest.client.say('leave', {});
    table.room.handleClose(guest.client);

    table.advance(STAND_IN_ABSENT_MS * 2);

    expect(table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.standIn).toBeNull();
  });

  it('never plays anybody’s hand while the table is paused', () => {
    const { table, creator, guest } = dealtTable();
    creator.client.say('pauseRequest', { paused: true });
    table.room.handleClose(guest.client);

    table.advance(STAND_IN_ABSENT_MS * 2);

    expect(table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.standIn).toBeNull();
  });

  it('covers a seat that is here but has not tapped anything in a long time', () => {
    const { table, guest } = dealtTable();
    // Nobody has closed anything: this seat is connected and simply not looking.
    table.advance(STAND_IN_IDLE_MS + 5_000);

    const seats = table.room.snapshotForTests().room?.seats ?? [];
    expect(seats.some((s) => s.standIn === 'idle')).toBe(true);
  });

  it('does not count a covered seat in the vote to end a round', () => {
    /*
     * Nobody is answering for that seat, which is usually exactly why the vote was
     * called. Counting it would make the exit unreachable.
     */
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(guest.client);
    table.advance(STAND_IN_ABSENT_MS + 5_000);

    creator.client.say('abandonVote', { agree: true });

    expect(table.room.snapshotForTests().room?.phase).toBe('finished');
  });

  it('lets a robot agree to a new round without saying so on anybody’s screen', () => {
    /*
     * A robot has to agree or a table with one could never deal again — and its
     * agreement must not be published, or the one person still there is told everybody
     * is ready while the table waits for them.
     */
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    creator.client.say('roomCommand', { command: { type: 'addBot' } });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    creator.client.say('abandonVote', { agree: true });
    expect(table.room.snapshotForTests().room?.phase).toBe('finished');

    creator.client.forget();
    creator.client.say('playAgainVote', { agree: false });
    const published = creator.client.expect('playAgainState').payload;
    expect(published.required).toBe(1);
    expect(published.agreed).toEqual([]);

    creator.client.say('playAgainVote', { agree: true });
    expect(table.room.snapshotForTests().room?.phase).toBe('inGame');
  });

  it('will not seat a robot mid-round, or into a full table', () => {
    const { table, creator } = dealtTable();
    creator.client.say('roomCommand', { command: { type: 'addBot' } });
    expect(table.room.snapshotForTests().room?.seats.length).toBe(2);

    const small = new Harness({ roomCode: '222222' });
    const host = small.join('Dana', { create: { maxPlayers: 2, tableLanguage: 'en' } });
    small.join('Yoni');
    host.client.say('roomCommand', { command: { type: 'addBot' } });
    expect(small.room.snapshotForTests().room?.seats.length).toBe(2);
  });

  it('numbers robots, and gives a second one a different number, across a hibernation', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    creator.client.say('roomCommand', { command: { type: 'addBot' } });
    creator.client.say('roomCommand', { command: { type: 'addBot' } });

    const names = (table.room.snapshotForTests().room?.seats ?? []).filter((s) => s.bot).map((s) => s.name);
    // A number, not a first name: what a seat is matters more than that it reads as
    // somebody, and the number tells two robots apart in the feed just as well.
    expect(names).toEqual(['רובוט 1', 'רובוט 2']);

    table.hibernate();
    const back = (table.room.snapshotForTests().room?.seats ?? []).filter((s) => s.bot);
    expect(back.map((s) => s.name)).toEqual(names);
  });

  it('takes a robot back off the table until the cards are dealt, and not after', () => {
    /*
     * The other half of seating one. A robot is the only seat the creator both puts
     * there and can take away with nothing lost — nobody is disconnected, nobody has
     * to be invited back — and the deal is the line, exactly as it is for a person.
     */
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    creator.client.say('roomCommand', { command: { type: 'addBot' } });
    creator.client.say('roomCommand', { command: { type: 'addBot' } });

    const first = (table.room.snapshotForTests().room?.seats ?? []).find((s) => s.bot);
    creator.client.say('roomCommand', { command: { type: 'kickPlayer', playerId: first?.playerId ?? '' } });

    const left = table.room.snapshotForTests().room?.seats ?? [];
    expect(left.map((s) => s.name)).toEqual(['Dana', 'רובוט 2']);
    // Seats close up behind it, and the room forgets the stream that fed it.
    expect(left.map((s) => s.seat)).toEqual([0, 1]);
    expect(Object.keys(table.room.snapshotForTests().room?.botRng ?? {})).not.toContain(first?.playerId);

    // The number it gave back is the number the next robot takes.
    creator.client.say('roomCommand', { command: { type: 'addBot' } });
    expect((table.room.snapshotForTests().room?.seats ?? []).map((s) => s.name)).toEqual([
      'Dana',
      'רובוט 2',
      'רובוט 1',
    ]);

    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    const dealt = (table.room.snapshotForTests().room?.seats ?? []).find((s) => s.bot);
    creator.client.say('roomCommand', { command: { type: 'kickPlayer', playerId: dealt?.playerId ?? '' } });
    expect(table.room.snapshotForTests().room?.seats.length).toBe(3);
  });

  it('passes a robot’s own seat if the robot does not move', () => {
    /*
     * The one thing the room does *for* a robot. A robot cannot be absent, so no grace,
     * hold or vacate would ever rescue a table stuck on one — a lost alarm or a bug in
     * the driver would stop the round with nothing on screen to explain it.
     */
    const table = new Harness({ botPauseMs: () => 10 * 60 * 1000 });
    const creator = table.join('Dana', CREATE);
    creator.client.say('roomCommand', { command: { type: 'addBot' } });
    creator.client.say('roomCommand', { command: { type: 'startGame' } });

    // Get the turn onto the robot, then let its stall deadline run out.
    for (let step = 0; step < 20; step += 1) {
      if (creator.client.state?.currentPlayerId !== creator.playerId) {
        break;
      }
      creator.client.takeTurn();
    }
    expect(creator.client.state?.currentPlayerId).not.toBe(creator.playerId);

    const seqBefore = creator.client.state?.turnSeq;
    table.advance(BOT_STALL_MS + 5_000);
    expect(creator.client.state?.turnSeq).not.toBe(seqBefore);
    expect(table.logs.some((line) => line.includes('robot'))).toBe(true);
  });
});

describe('what a refactor must not quietly undo', () => {
  it('keeps the deletion deadline across a hibernation, having written it', () => {
    /*
     * `flush()` settles the alarm queue *before* the writes, which reads backwards and
     * is therefore a prime refactor casualty. It is load-bearing: `reschedule` is the
     * only place that knows the room has emptied, so moving it back to the end means
     * `emptySince` is computed and never stored. The object is evicted between
     * messages on the real platform, so every wake would then re-derive the deadline
     * from `now` — which is the bug, silently restored.
     *
     * A test that never hibernates cannot see that, which is why this one does.
     */
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(creator.client);
    table.room.handleClose(guest.client);

    const emptiedAt = table.now();
    const stored = readRoom(table.store);
    expect(stored.ok).toBe(true);
    expect(stored.ok ? stored.value.emptySince : null).toBe(emptiedAt);

    table.advance(5 * 60 * 60 * 1000);
    table.hibernate();
    // One refused frame, to force the rebuilt room to flush at all.
    const stranger = table.client('Lost');
    stranger.say('joinRequest', { displayName: 'Lost' });

    // Still the original deadline, not five hours past the wake.
    expect(table.room.alarmAtForTests('ttl')).toBe(emptiedAt + 6 * 60 * 60 * 1000);
    table.advance(80 * 60 * 1000);
    expect(table.forgotten).toBe(true);
  });

  it('does not wake at all while the table is paused', () => {
    /*
     * Two layers enforce this — `reschedule`'s `live` check and `sweepStandIns`'s own
     * guard — so a test that only asserts "no robot took the seat" passes when either
     * one rots. Measured with the guard removed from `reschedule` alone: 512 wakes per
     * ten minutes, on the default table setting.
     */
    const { table, creator, guest } = dealtTable();
    creator.client.say('pauseRequest', { paused: true });
    table.room.handleClose(guest.client);

    table.wakes = 0;
    table.advance(10 * 60 * 1000);

    expect(table.wakes).toBe(0);
    expect(table.pendingAlarms()).toEqual([]);
  });

  it('never sends a covered seat’s hand to the rest of the table', () => {
    /*
     * The privacy sweep plays two humans, so nothing in it covers the robot path — and
     * "show the table what the robot is playing" is a natural thing for somebody to add.
     * A `broadcast` of a stood-in seat's hand in `beginStandIn` passed every other test
     * in this file.
     */
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const guest = table.join('Yoni');
    const third = table.join('Noa');
    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    table.room.handleClose(third.client);
    creator.client.forget();
    guest.client.forget();

    table.advance(STAND_IN_ABSENT_MS + 5_000);
    const covered = table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Noa');
    expect(covered?.standIn).toBe('absent');

    const game = table.room.snapshotForTests().game;
    const hidden = [
      ...(game?.hands[third.playerId] ?? []).map((card) => card.id),
      ...(game?.drawPile ?? []).map((card) => card.id),
    ];
    expect(hidden.length).toBeGreaterThan(0);
    for (const seat of [creator, guest]) {
      const mine = new Set((game?.hands[seat.playerId] ?? []).map((card) => card.id));
      for (const frame of seat.client.rawFrames) {
        for (const id of hidden) {
          if (mine.has(id)) {
            continue;
          }
          expect(frame.includes(id), `${seat.client.label} was sent ${id}`).toBe(false);
        }
      }
    }
  });

  it('takes back a play-again vote when a robot stops covering a seat', () => {
    /*
     * A robot agrees to a new round so a table with one can never be blocked. When the
     * seat comes back to its owner that agreement is not theirs, and leaving it behind
     * dealt people into rounds they were never asked about.
     *
     * The seat has to be one whose agreement is *counted*, which means present and
     * covered — a robot standing in for somebody who is away is deliberately not voted
     * for, because nobody is answering for that seat and "2 of 1 ready" is worse than
     * waiting. So: here, silent long enough to be covered, then speaking.
     */
    const { table, creator, guest } = dealtTable();
    // The idle stand-in covers whichever seat the table is *waiting on*, so find it
    // rather than assuming which.
    table.advance(STAND_IN_IDLE_MS + 5_000);
    const seats = table.room.snapshotForTests().room?.seats ?? [];
    const coveredId = seats.find((seat) => seat.standIn === 'idle')?.playerId;
    expect(coveredId, 'a seat is being covered').toBeDefined();
    const owner = [creator, guest].find((seat) => seat.playerId === coveredId);
    expect(owner, 'the covered seat belongs to one of these clients').toBeDefined();

    // The other player calls it: with the covered seat not counted, one vote ends it.
    const other = [creator, guest].find((seat) => seat.playerId !== coveredId);
    other!.client.say('abandonVote', { agree: true });
    expect(table.room.snapshotForTests().room?.phase).toBe('finished');
    expect(table.room.snapshotForTests().room?.playAgainVotes).toContain(coveredId);

    /*
     * Their own tap takes the seat straight back, and the agreement with it. Anything
     * they ask for will do, and deliberately *not* a `playAgainVote` — that removes the
     * vote by itself, so it cannot tell whether the release retracted anything.
     */
    owner!.client.say('abandonVote', { agree: false });

    const after = table.room.snapshotForTests().room;
    expect(after?.seats.find((seat) => seat.playerId === coveredId)?.standIn).toBeNull();
    expect(after?.playAgainVotes).not.toContain(coveredId);
    expect(after?.phase).toBe('finished');
  });

  it('marks a seat away when a bad resume closes its socket', () => {
    // The third path `dropSocket` was introduced for, and the only one without a test:
    // a seated socket whose next frame is a rejected resume.
    const { table, creator, guest } = dealtTable();
    creator.client.forget();

    guest.client.say('resumeRequest', { playerId: 'pl_nobody', resumeToken: 'a'.repeat(32) });

    expect(guest.client.expect('joinRejected').payload.reason).toBe('unknownSeat');
    expect(
      table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.absentSince,
    ).not.toBeNull();
  });

  it('carries the table language, and remembers a robot played a seat', () => {
    const table = new Harness();
    const creator = table.join('Dana', CREATE);
    const guest = table.join('Yoni');

    creator.client.say('roomCommand', { command: { type: 'setTableLanguage', language: 'en' } });
    expect(creator.client.expect('lobbyState').payload.lobby.tableLanguage).toBe('en');

    creator.client.say('roomCommand', { command: { type: 'startGame' } });
    table.room.handleClose(guest.client);
    table.advance(STAND_IN_ABSENT_MS + 5_000);

    // Recorded on the seat, and published, so the standings can say a robot was here.
    expect(
      table.room.snapshotForTests().room?.seats.find((s) => s.name === 'Yoni')?.robotPlayedThisRound,
    ).toBe(true);
    const seat = creator.client
      .expect('lobbyState')
      .payload.lobby.players.find((p) => p.id === guest.playerId);
    expect(seat?.robotPlayed).toBe(true);
  });
});
