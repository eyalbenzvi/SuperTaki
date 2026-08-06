import { describe, expect, it } from 'vitest';
import { ClientSession } from '../../../src/features/game/network/clientSession.ts';
import { createGame } from '../../../src/features/game/engine/engine.ts';
import { toPrivateHandView, toPublicGameState } from '../../../src/features/game/engine/views.ts';
import { ScriptedRoom, TEST_ROOM, createRecorder, flush } from '../helpers/room.ts';
import { players } from '../helpers/engineFixtures.ts';
import { PROTOCOL_VERSION } from '../../../src/features/game/network/protocol.ts';
import { RoomError } from '../../../src/features/game/network/roomTransport.ts';

const started = createGame(players('Alice', 'Bob'), 77);
if (!started.ok) {
  throw new Error('fixture failed');
}
const publicState = toPublicGameState(started.state);
const aliceHand = toPrivateHandView(started.state, 'p-alice');
const bobHand = toPrivateHandView(started.state, 'p-bob');

const lobby = {
  roomCode: TEST_ROOM,
  creatorPlayerId: 'pl_host0000',
  maxPlayers: 4,
  phase: 'inGame' as const,
  tableLanguage: 'he' as const,
  players: [
    { id: 'pl_host0000', name: 'Alice', isCreator: true, health: 'connected' as const, seat: 0 },
    { id: 'pl_client000', name: 'Bob', isCreator: false, health: 'connected' as const, seat: 1 },
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

async function connectClient(options: { maxAttempts?: number; accept?: boolean } = {}): Promise<{
  host: ScriptedRoom;
  session: ClientSession;
  recorder: ReturnType<typeof createRecorder>;
  destroy: () => void;
}> {
  const host = new ScriptedRoom(TEST_ROOM);
  const recorder = createRecorder();
  const session = new ClientSession({
    roomCode: TEST_ROOM,
    displayName: 'Bob',
    observer: recorder.observer,
    maxAttempts: options.maxAttempts ?? 5,
    connect: host.connect,
  });
  await session.start();
  await flush();

  if (options.accept !== false) {
    host.say('joinAccepted', {
      playerId: 'pl_client000',
      resumeToken: 'b'.repeat(32),
      displayName: 'Bob',
      lobby,
    });
    await flush();
  }

  return {
    host,
    session,
    recorder,
    destroy: () => {
      session.destroy('leftVoluntarily');
      host.dropAll();
    },
  };
}

describe('client join handshake', () => {
  it('sends a join request and stores the identity it is given', async () => {
    const harness = await connectClient();
    expect(harness.host.all('joinRequest')[0]?.payload).toEqual({ displayName: 'Bob' });
    expect(harness.recorder.last('identity')).toMatchObject({
      playerId: 'pl_client000',
      displayName: 'Bob',
    });
    expect(harness.recorder.last('phase')?.phase).toBe('connected');
    expect(harness.session.localPlayerId).toBe('pl_client000');
    harness.destroy();
  });

  it('stops rather than retrying when the room says there is nothing there', async () => {
    /*
     * The old shape of this was "no such peer", raised by the broker before any
     * room existed to answer. There is no peer to be absent now: the socket opens,
     * and the room on the other end says it has nothing in it. A mistyped code is
     * the common case, and retrying cannot improve a mistyped code — so the loop
     * stops and the UI offers an explicit retry instead.
     */
    const host = new ScriptedRoom(TEST_ROOM);
    const recorder = createRecorder();
    const session = new ClientSession({
      roomCode: TEST_ROOM,
      displayName: 'Bob',
      observer: recorder.observer,
      // Would allow five attempts; a definitive answer must still stop at once.
      maxAttempts: 5,
      connect: host.connect,
    });
    await session.start();
    await flush();

    host.say('joinRejected', { reason: 'roomClosed' });
    await flush();

    expect(recorder.last('phase')?.phase).toBe('failed');
    expect(recorder.last('error')?.error.code).toBe('roomClosed');
    expect(session.rejection).toBe('roomClosed');
    session.destroy('leftVoluntarily');
  });

  it('fails cleanly when no room server is configured for the build', async () => {
    const recorder = createRecorder();
    const session = new ClientSession({
      roomCode: TEST_ROOM,
      displayName: 'Bob',
      observer: recorder.observer,
      maxAttempts: 5,
      connect: () => Promise.reject(new RoomError('notConfigured', 'no relay')),
    });
    await session.start();
    await flush();

    // Nothing about this improves by trying again, so it does not.
    expect(recorder.last('phase')?.phase).toBe('failed');
    expect(recorder.last('error')?.error.code).toBe('notConfigured');
    expect(recorder.ofType('error')).toHaveLength(1);
    session.destroy('leftVoluntarily');
  });
});

describe('state ordering and privacy', () => {
  it('drops a snapshot older than the newest one applied', async () => {
    const harness = await connectClient();
    harness.host.say('publicState', { state: { ...publicState, version: 5 } });
    await flush();
    harness.host.say('publicState', { state: { ...publicState, version: 3 } });
    await flush();

    const versions = harness.recorder.ofType('publicState').map((update) => update.state.version);
    expect(versions).toEqual([5]);
    harness.destroy();
  });

  it('accepts a snapshot with the same version (a resend)', async () => {
    const harness = await connectClient();
    harness.host.say('publicState', { state: { ...publicState, version: 5 } });
    await flush();
    harness.host.say('publicState', { state: { ...publicState, version: 5 } });
    await flush();
    expect(harness.recorder.ofType('publicState')).toHaveLength(2);
    harness.destroy();
  });

  it('ignores a hand that belongs to another player', async () => {
    const harness = await connectClient();
    harness.host.say('privateHand', { hand: { ...aliceHand, playerId: 'pl_host0000' } });
    await flush();
    expect(harness.recorder.ofType('hand')).toHaveLength(0);

    harness.host.say('privateHand', { hand: { ...bobHand, playerId: 'pl_client000' } });
    await flush();
    expect(harness.recorder.ofType('hand')).toHaveLength(1);
    harness.destroy();
  });

  it('drops an out-of-order hand update', async () => {
    const harness = await connectClient();
    const hand = { ...bobHand, playerId: 'pl_client000' };
    harness.host.say('privateHand', { hand: { ...hand, version: 9 } });
    await flush();
    harness.host.say('privateHand', { hand: { ...hand, version: 4 } });
    await flush();
    expect(harness.recorder.ofType('hand')).toHaveLength(1);
    harness.destroy();
  });

  it('drops a replayed message', async () => {
    const harness = await connectClient();
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      id: 'replayed-1',
      roomId: TEST_ROOM,
      senderPeerId: 'room',
      timestamp: 1,
      type: 'publicState',
      payload: { state: publicState },
    };
    harness.host.sayRaw(message);
    await flush();
    harness.host.sayRaw(message);
    await flush();
    expect(harness.recorder.ofType('publicState')).toHaveLength(1);
    harness.destroy();
  });

  it('ignores traffic addressed to another room', async () => {
    const harness = await connectClient();
    harness.host.sayRaw({
      protocolVersion: PROTOCOL_VERSION,
      id: 'other-room-1',
      roomId: 'OTHER-ROOM-11',
      senderPeerId: 'room',
      timestamp: 1,
      type: 'publicState',
      payload: { state: publicState },
    });
    await flush();
    expect(harness.recorder.ofType('publicState')).toHaveLength(0);
    harness.destroy();
  });

  it('reports a protocol mismatch from the host', async () => {
    const harness = await connectClient();
    harness.host.sayRaw({
      protocolVersion: 42,
      id: 'stale-1',
      roomId: TEST_ROOM,
      senderPeerId: 'room',
      timestamp: 1,
      type: 'lobbyState',
      payload: { lobby },
    });
    await flush();
    expect(harness.recorder.last('error')?.error.code).toBe('protocolMismatch');
    harness.destroy();
  });

  it('ignores a malformed host message', async () => {
    const harness = await connectClient();
    harness.recorder.clear();
    harness.host.sayRaw({ nonsense: true });
    harness.host.sayRaw({
      protocolVersion: PROTOCOL_VERSION,
      id: 'bad-1',
      roomId: TEST_ROOM,
      senderPeerId: 'room',
      timestamp: 1,
      type: 'publicState',
      payload: { state: { version: 'x' } },
    });
    await flush();
    expect(harness.recorder.updates).toHaveLength(0);
    harness.destroy();
  });
});

describe('host-driven lifecycle messages', () => {
  it('forwards events, rejections and play-again state', async () => {
    const harness = await connectClient();
    harness.host.say('gameEvents', {
      version: 2,
      events: [{ type: 'turnChanged', playerId: 'pl_client000' }],
    });
    harness.host.say('actionRejected', { code: 'illegalCard' });
    harness.host.say('playAgainState', { agreed: ['pl_client000'], required: 2 });
    await flush();

    expect(harness.recorder.last('events')?.events).toHaveLength(1);
    expect(harness.recorder.last('actionRejected')?.code).toBe('illegalCard');
    expect(harness.recorder.last('playAgain')).toMatchObject({ agreed: ['pl_client000'], required: 2 });
    harness.destroy();
  });

  it('closes the session when removed by the room creator', async () => {
    const harness = await connectClient();
    harness.host.say('kicked', { reason: 'removedByCreator' });
    await flush();
    expect(harness.recorder.last('closed')?.reason).toBe('removedByCreator');
    expect(harness.recorder.last('phase')?.phase).toBe('disconnected');
    harness.destroy();
  });

  it('closes the session when a duplicate connection is detected', async () => {
    const harness = await connectClient();
    harness.host.say('kicked', { reason: 'duplicateConnection' });
    await flush();
    expect(harness.recorder.last('closed')?.reason).toBe('duplicateConnection');
    harness.destroy();
  });

  it.each(['roomClosed', 'roomReset'] as const)(
    'closes the session when the room reports %s',
    async (reason) => {
      /*
       * Both are terminal, and that is the change. There used to be four reasons here
       * and two of them — a host reloading, a host handing over — were not endings at
       * all, so a client had to hold its seat through them. A room does not reload and
       * does not move.
       */
      const harness = await connectClient();
      harness.host.say('roomClosed', { reason });
      await flush();
      expect(harness.recorder.last('closed')?.reason).toBe(reason);
      harness.destroy();
    },
  );

  it('stops retrying after a definitive rejection but allows a manual retry', async () => {
    const harness = await connectClient({ accept: false });
    harness.host.say('joinRejected', { reason: 'roomFull' });
    await flush(6);

    expect(harness.recorder.last('error')?.error.code).toBe('roomFull');
    expect(harness.recorder.last('phase')?.phase).toBe('failed');

    harness.recorder.clear();
    harness.session.retry();
    await flush();
    expect(harness.recorder.ofType('phase').map((update) => update.phase)).toContain('reconnecting');
    harness.destroy();
  });

  it('sends actions and votes as intents only', async () => {
    const harness = await connectClient();
    harness.session.submitAction({ type: 'playCard', cardId: 'n-red-5-0' });
    harness.session.votePlayAgain(true);
    await flush();

    const action = harness.host.all('action')[0];
    expect(action?.payload).toMatchObject({ action: { type: 'playCard', cardId: 'n-red-5-0' } });
    // The request id identifies the *intent*, so a re-send after a reconnect can
    // be recognised as the same one rather than applied twice.
    expect(action?.payload).toHaveProperty('requestId');
    // Crucially, the client never states who it is: the host binds the identity.
    expect(JSON.stringify(action?.payload)).not.toContain('pl_client000');
    expect(harness.host.all('playAgainVote')[0]?.payload).toEqual({ agree: true });
    harness.destroy();
  });

  it('announces a voluntary departure to the host', async () => {
    const harness = await connectClient();
    harness.session.destroy('leftVoluntarily');
    await flush();
    expect(harness.host.all('leave')).toHaveLength(1);
    expect(harness.recorder.last('closed')?.reason).toBe('leftVoluntarily');
    harness.host.dropAll();
  });

  it('is idempotent when destroyed twice', async () => {
    const harness = await connectClient();
    harness.session.destroy('leftVoluntarily');
    harness.session.destroy('leftVoluntarily');
    await flush();
    expect(harness.recorder.ofType('closed')).toHaveLength(1);
    harness.host.dropAll();
  });
});
