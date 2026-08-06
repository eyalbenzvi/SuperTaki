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
import {
  ABSENT_TURN_GRACE_CLOSED_MS,
  IDLE_TURN_NUDGE_MS,
  LOBBY_GRACE_MS,
  RESUME_ATTEMPT_SUPPRESSES_SKIP_MS,
  STAND_IN_ABSENT_MS,
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

  it('supersedes an older socket for the same seat', () => {
    const { table, guest } = dealtTable();
    const second = table.client('Yoni-tab2');
    second.say('resumeRequest', { playerId: guest.playerId, resumeToken: guest.resumeToken });

    expect(second.last('joinAccepted')).toBeDefined();
    expect(guest.client.closed?.code).toBe(4001);
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
    // Make sure the absent seat is the one on turn.
    let onTurn = seats.find((s) => s.playerId === currentPlayerId(creator.client))!;
    if (onTurn.playerId === creator.playerId) {
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
     * And it cost them nothing. A disconnect is not a decision, so a skip is free —
     * charging a card would leave a returning player several cards down after a seat
     * had been faithfully held for them, which makes the whole promise theatre.
     *
     * Asserted on the card count rather than on a `turnSkipped` event, because the
     * engine reaches the same place by more than one route: a seat holding an open
     * Taki has its sequence closed first, and if that ends the turn there is nothing
     * left to skip and no such event. The count is the invariant either way.
     */
    expect(watcher.client.state?.players.find((p) => p.id === away.playerId)?.cardCount).toBe(cardsBefore);
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
    expect(waited.length).toBeGreaterThan(0);
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
    void table;
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
    expect(lobby.players.find((p) => p.id === guest.playerId)?.standIn).toBe(true);
  });

  it('hands the seat straight back the moment its owner speaks', () => {
    const { table, creator, guest } = dealtTable();
    table.room.handleClose(guest.client);
    table.advance(STAND_IN_ABSENT_MS + 5_000);

    const back = table.client('Yoni-back');
    back.say('resumeRequest', { playerId: guest.playerId, resumeToken: guest.resumeToken });
    const lobby = back.expect('joinAccepted').payload.lobby;
    expect(lobby.players.find((p) => p.id === guest.playerId)?.standIn).toBeUndefined();
  });
});

describe('privacy', () => {
  it('never sends one player a card id from another player’s hand', () => {
    // The invariant, asserted where the frames are rather than against a projection.
    // Every byte the room sent each client is searched for every card the *others*
    // were holding at the time, over a whole round.
    const { table, creator, guest } = dealtTable();
    const seats = [creator, guest];

    for (let move = 0; move < 400; move += 1) {
      if (creator.client.state?.phase === 'finished') {
        break;
      }

      const game = table.room.snapshotForTests().game;
      expect(game).not.toBeNull();

      for (const seat of seats) {
        const mine = new Set((game!.hands[seat.playerId] ?? []).map((card) => card.id));
        const theirs = seats
          .filter((other) => other.playerId !== seat.playerId)
          .flatMap((other) => (game!.hands[other.playerId] ?? []).map((card) => card.id))
          // A card can legitimately appear in a frame once it is the visible discard
          // top; only ids still in somebody else's hand are secret.
          .filter((id) => !mine.has(id));

        for (const frame of seat.client.rawFrames) {
          for (const id of theirs) {
            expect(frame.includes(id), `${seat.client.label} was sent ${id}`).toBe(false);
          }
        }
      }
      for (const seat of seats) {
        seat.client.forget();
      }
      takeTurn(seats);
      // Robots and deadlines get their turn too, so the sweep covers alarm-driven
      // broadcasts and not only the ones a move caused.
      table.advance(100);
    }
  });

  it('sends a hand only to the socket that owns the seat', () => {
    const { creator, guest } = dealtTable();
    for (const hand of creator.client.all('privateHand')) {
      expect(hand.payload.hand.playerId).toBe(creator.playerId);
    }
    for (const hand of guest.client.all('privateHand')) {
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
});
