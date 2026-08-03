import { describe, expect, it } from 'vitest';
import { ClientSession } from '../../../src/features/game/network/clientSession.ts';
import { MemoryNetwork } from '../../../src/features/game/network/memoryTransport.ts';
import { createGame } from '../../../src/features/game/engine/engine.ts';
import { toPrivateHandView, toPublicGameState } from '../../../src/features/game/engine/views.ts';
import { TEST_ROOM, createRecorder, createScriptedPeer, flush } from '../helpers/net.ts';
import { players } from '../helpers/engineFixtures.ts';

const HOST_ID = 'scripted-host';

const started = createGame(players('Alice', 'Bob'), 77);
if (!started.ok) {
  throw new Error('fixture failed');
}
const publicState = toPublicGameState(started.state);
const aliceHand = toPrivateHandView(started.state, 'p-alice');
const bobHand = toPrivateHandView(started.state, 'p-bob');

const lobby = {
  roomCode: TEST_ROOM,
  hostPeerId: HOST_ID,
  hostPlayerId: 'pl_host0000',
  maxPlayers: 4,
  phase: 'inGame' as const,
  tableLanguage: 'he' as const,
  players: [
    { id: 'pl_host0000', name: 'Alice', isHost: true, health: 'connected' as const, seat: 0 },
    { id: 'pl_client000', name: 'Bob', isHost: false, health: 'connected' as const, seat: 1 },
  ],
};

async function connectClient(options: { maxAttempts?: number; accept?: boolean } = {}): Promise<{
  network: MemoryNetwork;
  host: ReturnType<typeof createScriptedPeer>;
  session: ClientSession;
  recorder: ReturnType<typeof createRecorder>;
  destroy: () => void;
}> {
  const network = new MemoryNetwork();
  const host = createScriptedPeer(network, HOST_ID);
  const recorder = createRecorder();
  const session = new ClientSession({
    transport: network.create('client-a'),
    roomCode: TEST_ROOM,
    hostPeerId: HOST_ID,
    displayName: 'Bob',
    observer: recorder.observer,
    heartbeatIntervalMs: 100_000,
    maxAttempts: options.maxAttempts ?? 5,
  });
  await session.start();
  await flush();

  if (options.accept !== false) {
    host.send(
      host.envelope('joinAccepted', {
        playerId: 'pl_client000',
        resumeToken: 'b'.repeat(32),
        displayName: 'Bob',
        lobby,
      }),
    );
    await flush();
  }

  return {
    network,
    host,
    session,
    recorder,
    destroy: () => {
      session.destroy('leftVoluntarily');
      host.close();
    },
  };
}

describe('client join handshake', () => {
  it('sends a join request and stores the identity it is given', async () => {
    const harness = await connectClient();
    expect(harness.host.ofType('joinRequest')[0]?.payload).toEqual({ displayName: 'Bob' });
    expect(harness.recorder.last('identity')).toMatchObject({
      playerId: 'pl_client000',
      displayName: 'Bob',
    });
    expect(harness.recorder.last('phase')?.phase).toBe('connected');
    expect(harness.session.localPlayerId).toBe('pl_client000');
    harness.destroy();
  });

  it('does not retry when the room does not exist', async () => {
    const network = new MemoryNetwork();
    const recorder = createRecorder();
    const session = new ClientSession({
      transport: network.create('client-nobody'),
      roomCode: TEST_ROOM,
      hostPeerId: 'nobody-here',
      displayName: 'Bob',
      observer: recorder.observer,
      // Would allow five attempts; an absent host must still fail immediately.
      maxAttempts: 5,
    });
    await session.start();
    await flush();

    expect(recorder.last('phase')?.phase).toBe('failed');
    expect(recorder.ofType('error')).toHaveLength(1);
    session.destroy('leftVoluntarily');
  });

  it('fails cleanly when the host peer does not exist', async () => {
    const network = new MemoryNetwork();
    const recorder = createRecorder();
    const session = new ClientSession({
      transport: network.create('client-lonely'),
      roomCode: TEST_ROOM,
      hostPeerId: 'nobody-here',
      displayName: 'Bob',
      observer: recorder.observer,
      maxAttempts: 1,
    });
    await session.start();

    expect(recorder.last('phase')?.phase).toBe('failed');
    expect(recorder.last('error')?.error.code).toBe('peerUnavailable');
    expect(recorder.last('error')?.error.retryable).toBe(true);
    session.destroy('leftVoluntarily');
  });
});

describe('state ordering and privacy', () => {
  it('drops a snapshot older than the newest one applied', async () => {
    const harness = await connectClient();
    harness.host.send(harness.host.envelope('publicState', { state: { ...publicState, version: 5 } }));
    await flush();
    harness.host.send(harness.host.envelope('publicState', { state: { ...publicState, version: 3 } }));
    await flush();

    const versions = harness.recorder.ofType('publicState').map((update) => update.state.version);
    expect(versions).toEqual([5]);
    harness.destroy();
  });

  it('accepts a snapshot with the same version (a resend)', async () => {
    const harness = await connectClient();
    harness.host.send(harness.host.envelope('publicState', { state: { ...publicState, version: 5 } }));
    await flush();
    harness.host.send(harness.host.envelope('publicState', { state: { ...publicState, version: 5 } }));
    await flush();
    expect(harness.recorder.ofType('publicState')).toHaveLength(2);
    harness.destroy();
  });

  it('ignores a hand that belongs to another player', async () => {
    const harness = await connectClient();
    harness.host.send(
      harness.host.envelope('privateHand', { hand: { ...aliceHand, playerId: 'pl_host0000' } }),
    );
    await flush();
    expect(harness.recorder.ofType('hand')).toHaveLength(0);

    harness.host.send(
      harness.host.envelope('privateHand', { hand: { ...bobHand, playerId: 'pl_client000' } }),
    );
    await flush();
    expect(harness.recorder.ofType('hand')).toHaveLength(1);
    harness.destroy();
  });

  it('drops an out-of-order hand update', async () => {
    const harness = await connectClient();
    const hand = { ...bobHand, playerId: 'pl_client000' };
    harness.host.send(harness.host.envelope('privateHand', { hand: { ...hand, version: 9 } }));
    await flush();
    harness.host.send(harness.host.envelope('privateHand', { hand: { ...hand, version: 4 } }));
    await flush();
    expect(harness.recorder.ofType('hand')).toHaveLength(1);
    harness.destroy();
  });

  it('drops a replayed message', async () => {
    const harness = await connectClient();
    const message = harness.host.envelope('publicState', { state: publicState });
    harness.host.send(message);
    await flush();
    harness.host.send(message);
    await flush();
    expect(harness.recorder.ofType('publicState')).toHaveLength(1);
    harness.destroy();
  });

  it('ignores traffic addressed to another room', async () => {
    const harness = await connectClient();
    harness.host.send(
      harness.host.envelope('publicState', { state: publicState }, { roomId: 'OTHER-ROOM-11' }),
    );
    await flush();
    expect(harness.recorder.ofType('publicState')).toHaveLength(0);
    harness.destroy();
  });

  it('reports a protocol mismatch from the host', async () => {
    const harness = await connectClient();
    harness.host.send(harness.host.envelope('lobbyState', { lobby }, { protocolVersion: 42 }));
    await flush();
    expect(harness.recorder.last('error')?.error.code).toBe('protocolMismatch');
    harness.destroy();
  });

  it('ignores a malformed host message', async () => {
    const harness = await connectClient();
    harness.recorder.clear();
    harness.host.send({ nonsense: true });
    harness.host.send(harness.host.envelope('publicState', { state: { version: 'x' } }));
    await flush();
    expect(harness.recorder.updates).toHaveLength(0);
    harness.destroy();
  });
});

describe('host-driven lifecycle messages', () => {
  it('answers a heartbeat ping with a matching pong', async () => {
    const harness = await connectClient();
    harness.host.send(harness.host.envelope('ping', { nonce: 'nonce-1' }));
    await flush();
    expect(harness.host.ofType('pong')[0]?.payload).toEqual({ nonce: 'nonce-1' });
    harness.destroy();
  });

  it('ignores an unsolicited pong', async () => {
    const harness = await connectClient();
    harness.recorder.clear();
    harness.host.send(harness.host.envelope('pong', { nonce: 'nonce-1' }));
    await flush();
    expect(harness.recorder.updates).toHaveLength(0);
    harness.destroy();
  });

  it('forwards events, rejections and play-again state', async () => {
    const harness = await connectClient();
    harness.host.send(
      harness.host.envelope('gameEvents', {
        version: 2,
        events: [{ type: 'turnChanged', playerId: 'pl_client000' }],
      }),
    );
    harness.host.send(harness.host.envelope('actionRejected', { code: 'illegalCard' }));
    harness.host.send(harness.host.envelope('playAgainState', { agreed: ['pl_client000'], required: 2 }));
    await flush();

    expect(harness.recorder.last('events')?.events).toHaveLength(1);
    expect(harness.recorder.last('actionRejected')?.code).toBe('illegalCard');
    expect(harness.recorder.last('playAgain')).toMatchObject({ agreed: ['pl_client000'], required: 2 });
    harness.destroy();
  });

  it('closes the session when removed by the host', async () => {
    const harness = await connectClient();
    harness.host.send(harness.host.envelope('kicked', { reason: 'removedByHost' }));
    await flush();
    expect(harness.recorder.last('closed')?.reason).toBe('removedByHost');
    expect(harness.recorder.last('phase')?.phase).toBe('disconnected');
    harness.destroy();
  });

  it('closes the session when a duplicate connection is detected', async () => {
    const harness = await connectClient();
    harness.host.send(harness.host.envelope('kicked', { reason: 'duplicateConnection' }));
    await flush();
    expect(harness.recorder.last('closed')?.reason).toBe('duplicateConnection');
    harness.destroy();
  });

  it.each([
    ['hostLeft', 'hostLeft'],
    ['roomReset', 'roomReset'],
  ])('closes the session when the host reports %s', async (reason, expected) => {
    const harness = await connectClient();
    harness.host.send(harness.host.envelope('hostClosed', { reason }));
    await flush();
    expect(harness.recorder.last('closed')?.reason).toBe(expected);
    harness.destroy();
  });

  it('stops retrying after a definitive rejection but allows a manual retry', async () => {
    const harness = await connectClient({ accept: false });
    harness.host.send(harness.host.envelope('joinRejected', { reason: 'roomFull' }));
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

    const action = harness.host.ofType('action')[0];
    expect(action?.payload).toEqual({ action: { type: 'playCard', cardId: 'n-red-5-0' } });
    // Crucially, the client never states who it is: the host binds the identity.
    expect(JSON.stringify(action?.payload)).not.toContain('pl_client000');
    expect(harness.host.ofType('playAgainVote')[0]?.payload).toEqual({ agree: true });
    harness.destroy();
  });

  it('announces a voluntary departure to the host', async () => {
    const harness = await connectClient();
    harness.session.destroy('leftVoluntarily');
    await flush();
    expect(harness.host.ofType('leave')).toHaveLength(1);
    expect(harness.recorder.last('closed')?.reason).toBe('leftVoluntarily');
    harness.host.close();
  });

  it('is idempotent when destroyed twice', async () => {
    const harness = await connectClient();
    harness.session.destroy('leftVoluntarily');
    harness.session.destroy('leftVoluntarily');
    await flush();
    expect(harness.recorder.ofType('closed')).toHaveLength(1);
    harness.host.close();
  });
});
