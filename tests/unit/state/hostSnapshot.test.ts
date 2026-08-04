import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetHostSnapshotThrottleForTests,
  clearHostedRoom,
  flushHostedRoom,
  loadHostedRoom,
  saveHostedRoom,
  validateHandoffSnapshot,
} from '../../../src/features/game/state/hostSnapshot.ts';
import type { HostRestoreState } from '../../../src/features/game/network/hostSession.ts';
import { cards, makeState, players } from '../helpers/engineFixtures.ts';

const ROOM = '482913';
const PEER = 'crush-482913';

function restore(overrides: Partial<HostRestoreState> = {}): HostRestoreState {
  return {
    hostPlayerId: 'p-alice',
    phase: 'inGame',
    maxPlayers: 4,
    tableLanguage: 'he',
    versionFloor: 12,
    round: 1,
    seats: [
      {
        playerId: 'p-alice',
        name: 'Alice',
        seat: 0,
        isHost: true,
        resumeToken: 'aaaaaaaaaaaaaaaa',
        lastRequestId: null,
        lastRequestVersion: null,
      },
      {
        playerId: 'p-bob',
        name: 'Bob',
        seat: 1,
        isHost: false,
        resumeToken: 'bbbbbbbbbbbbbbbb',
        lastRequestId: 'rq-9',
        lastRequestVersion: 11,
      },
    ],
    game: makeState({
      players: players('Alice', 'Bob'),
      hands: { 'p-alice': cards('red:1'), 'p-bob': cards('blue:5') },
      version: 12,
    }),
    ...overrides,
  };
}

function args(overrides: Partial<HostRestoreState> = {}) {
  return { roomCode: ROOM, hostPeerId: PEER, generation: 0, restore: restore(overrides) };
}

beforeEach(() => {
  clearHostedRoom();
  __resetHostSnapshotThrottleForTests();
});

describe('remembering a hosted room', () => {
  it('survives a round trip with everything a restore needs', () => {
    saveHostedRoom(args(), 1_000);
    const loaded = loadHostedRoom(1_000);

    expect(loaded?.roomCode).toBe(ROOM);
    expect(loaded?.hostPeerId).toBe(PEER);
    // The host's own player id, or every move it makes on returning is refused as
    // coming from a stranger and its hand renders empty.
    expect(loaded?.restore.hostPlayerId).toBe('p-alice');
    // The version floor, or the returning host broadcasts versions every client
    // discards as stale — a lesson this codebase learned once already.
    expect(loaded?.restore.versionFloor).toBe(12);
    // Every seat's credential, so the guests' stored tokens still fit.
    expect(loaded?.restore.seats.map((seat) => seat.resumeToken)).toEqual([
      'aaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbb',
    ]);
    // And the last intent each seat had accepted, or a client replaying after the
    // restart gets its move applied a second time.
    expect(loaded?.restore.seats[1]?.lastRequestId).toBe('rq-9');
    expect(loaded?.restore.game?.version).toBe(12);
  });

  it('refuses a snapshot that is too old to be about this evening', () => {
    saveHostedRoom(args(), 1_000);
    expect(loadHostedRoom(1_000 + 7 * 60 * 60 * 1000)).toBeNull();
  });

  it('refuses a snapshot from the future, which means a clock it cannot trust', () => {
    saveHostedRoom(args(), 10_000_000);
    expect(loadHostedRoom(1_000)).toBeNull();
  });

  it('refuses a corrupt snapshot instead of restoring half a room', () => {
    saveHostedRoom(args(), 1_000);
    const raw = window.sessionStorage.getItem('superTaki:hostedRoom') ?? '';
    window.sessionStorage.setItem(
      'superTaki:hostedRoom',
      raw.replace('"phase":"inGame"', '"phase":"nonsense"'),
    );
    expect(loadHostedRoom(1_000)).toBeNull();
  });

  it('can be forgotten', () => {
    saveHostedRoom(args(), 1_000);
    clearHostedRoom();
    expect(loadHostedRoom(1_000)).toBeNull();
  });
});

describe('how often it writes', () => {
  it('writes a structural change at once, however recently it last wrote', () => {
    saveHostedRoom(args({ phase: 'lobby' }), 1_000);
    expect(loadHostedRoom(1_000)?.restore.phase).toBe('lobby');

    // Well inside the throttle window. Delaying this is what would let a reload
    // restore a room that still believed it was in the lobby.
    saveHostedRoom(args({ phase: 'inGame' }), 1_100);
    expect(loadHostedRoom(1_100)?.restore.phase).toBe('inGame');
  });

  it('defers a change that is only cards, and catches up on the next window', () => {
    vi.useFakeTimers();
    try {
      saveHostedRoom(args(), 1_000);
      const first = loadHostedRoom(1_000)?.savedAt;

      // Same shape, new deck: 8-12 KB of synchronous JSON on the tap that plays a
      // card is felt on a mid-range phone, and a snapshot one move behind costs
      // nothing because clients drop any version older than the one they hold.
      saveHostedRoom(args(), 1_100);
      expect(loadHostedRoom(1_100)?.savedAt).toBe(first);

      vi.advanceTimersByTime(3_000);
      expect(loadHostedRoom(Date.now())?.savedAt).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurrect a room that has been forgotten', () => {
    vi.useFakeTimers();
    try {
      saveHostedRoom(args(), 1_000);
      // A deferred write is now queued. Forgetting the room has to cancel it, or
      // the write lands afterwards and the player is offered a room they left.
      saveHostedRoom(args(), 1_100);
      clearHostedRoom();
      vi.advanceTimersByTime(5_000);
      expect(loadHostedRoom(Date.now())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes immediately when the page is going away', () => {
    saveHostedRoom(args(), 1_000);
    const first = loadHostedRoom(1_000)?.savedAt;
    flushHostedRoom(args(), 1_100);
    // `pagehide` is the last reliable moment on a phone, so nothing may be queued
    // when it fires.
    expect(loadHostedRoom(1_100)?.savedAt).not.toBe(first);
  });
});

describe('a room offered by another device', () => {
  it('accepts a well-formed state', () => {
    expect(validateHandoffSnapshot(JSON.parse(JSON.stringify(restore())))).not.toBeNull();
  });

  it('refuses one it cannot read, before serving on it', () => {
    // Not because the old host is suspected — it is alive and cooperating — but
    // because an unreadable state has to fail here rather than half-way through
    // somebody's first move.
    expect(validateHandoffSnapshot({ nonsense: true })).toBeNull();
    expect(validateHandoffSnapshot(null)).toBeNull();
  });
});
