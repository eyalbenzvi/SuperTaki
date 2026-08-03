import { describe, expect, it } from 'vitest';
import { createHostSession, type HostSession } from '../../../src/features/game/network/hostSession.ts';
import { createClientSession, type ClientSession } from '../../../src/features/game/network/clientSession.ts';
import { MemoryNetwork } from '../../../src/features/game/network/memoryTransport.ts';
import { hostPeerIdForRoom } from '../../../src/features/game/network/roomCode.ts';
import { isCardPlayable } from '../../../src/features/game/engine/rules.ts';
import { playContextFromPublic } from '../../../src/features/game/engine/views.ts';
import { TEST_ROOM, createRecorder, createScriptedPeer, flush } from '../helpers/net.ts';
import type { Card } from '../../../src/features/game/engine/cards.ts';
import type { PublicGameState } from '../../../src/features/game/engine/views.ts';
import type { GameAction } from '../../../src/features/game/network/protocol.ts';

const HOST_PEER_ID = hostPeerIdForRoom(TEST_ROOM);

interface Harness {
  network: MemoryNetwork;
  host: HostSession;
  hostRecorder: ReturnType<typeof createRecorder>;
  clients: Array<{ session: ClientSession; recorder: ReturnType<typeof createRecorder> }>;
  addClient(
    name: string,
    resume?: { playerId: string; resumeToken: string },
  ): Promise<{
    session: ClientSession;
    recorder: ReturnType<typeof createRecorder>;
  }>;
  destroy(): void;
}

async function createHarness(options: { maxPlayers?: number } = {}): Promise<Harness> {
  const network = new MemoryNetwork();
  const hostRecorder = createRecorder();
  const host = await createHostSession({
    transport: network.create(HOST_PEER_ID),
    roomCode: TEST_ROOM,
    hostDisplayName: 'Host',
    maxPlayers: options.maxPlayers ?? 4,
    tableLanguage: 'he',
    observer: hostRecorder.observer,
    seedFactory: () => 4242,
    heartbeatIntervalMs: 100_000,
  });

  const clients: Harness['clients'] = [];
  let counter = 0;

  return {
    network,
    host,
    hostRecorder,
    clients,
    async addClient(name, resume) {
      counter += 1;
      const recorder = createRecorder();
      const session = await createClientSession({
        transport: network.create(`client-${counter}`),
        roomCode: TEST_ROOM,
        hostPeerId: HOST_PEER_ID,
        displayName: name,
        observer: recorder.observer,
        heartbeatIntervalMs: 100_000,
        ...(resume ? { resume } : {}),
      });
      await flush();
      const entry = { session, recorder };
      clients.push(entry);
      return entry;
    },
    destroy() {
      for (const client of clients) {
        client.session.destroy('leftVoluntarily');
      }
      host.destroy('leftVoluntarily');
    },
  };
}

function currentHand(recorder: ReturnType<typeof createRecorder>): readonly Card[] {
  return recorder.last('hand')?.cards ?? [];
}

function currentState(recorder: ReturnType<typeof createRecorder>): PublicGameState | undefined {
  return recorder.last('publicState')?.state;
}

/** Finds a legal card for whoever must act, from the perspective of one recorder. */
function pickLegalCard(recorder: ReturnType<typeof createRecorder>): Card | undefined {
  const state = currentState(recorder);
  if (!state) {
    return undefined;
  }
  const context = playContextFromPublic(state);
  return currentHand(recorder).find((card) => isCardPlayable(card, context));
}

describe('lobby lifecycle over a mock transport', () => {
  it('seats the host immediately', async () => {
    const harness = await createHarness();
    const lobby = harness.hostRecorder.last('lobby')?.lobby;
    expect(lobby?.players).toHaveLength(1);
    expect(lobby?.players[0]).toMatchObject({ isHost: true, seat: 0, health: 'connected' });
    expect(harness.hostRecorder.last('phase')?.phase).toBe('connected');
    harness.destroy();
  });

  it('accepts a joining client and shares the lobby with everyone', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');

    expect(client.recorder.last('phase')?.phase).toBe('connected');
    const identity = client.recorder.last('identity');
    expect(identity?.playerId).toMatch(/^pl_/);
    expect(identity?.resumeToken).toHaveLength(32);
    expect(identity?.displayName).toBe('Dana');

    const hostLobby = harness.hostRecorder.last('lobby')?.lobby;
    expect(hostLobby?.players.map((player) => player.name)).toEqual(['Host', 'Dana']);
    const clientLobby = client.recorder.last('lobby')?.lobby;
    expect(clientLobby?.players).toHaveLength(2);
    expect(clientLobby?.hostPlayerId).toBe(harness.host.localPlayerId);
    harness.destroy();
  });

  it('de-duplicates display names', async () => {
    const harness = await createHarness();
    await harness.addClient('Dana');
    const second = await harness.addClient('Dana');
    expect(second.recorder.last('identity')?.displayName).toBe('Dana 2');
    harness.destroy();
  });

  it('sanitises hostile display names', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('  Da‮na  ');
    expect(client.recorder.last('identity')?.displayName).toBe('Dana');
    harness.destroy();
  });

  it('rejects a join when the room is full', async () => {
    const harness = await createHarness({ maxPlayers: 2 });
    await harness.addClient('Dana');
    const third = await harness.addClient('Eli');
    await flush();
    expect(third.recorder.last('error')?.error.code).toBe('roomFull');
    expect(third.recorder.last('phase')?.phase).toBe('failed');
    harness.destroy();
  });

  it('lets the host raise the player limit but not below the seated count', async () => {
    const harness = await createHarness({ maxPlayers: 2 });
    await harness.addClient('Dana');
    harness.host.setMaxPlayers(6);
    expect(harness.hostRecorder.last('lobby')?.lobby.maxPlayers).toBe(6);
    harness.host.setMaxPlayers(1);
    expect(harness.hostRecorder.last('lobby')?.lobby.maxPlayers).toBe(2);
    harness.destroy();
  });

  it('lets the host change the table language', async () => {
    const harness = await createHarness();
    harness.host.setTableLanguage('en');
    expect(harness.hostRecorder.last('lobby')?.lobby.tableLanguage).toBe('en');
    harness.destroy();
  });

  it('lets the host remove a player before the game starts', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    const playerId = client.recorder.last('identity')!.playerId;

    harness.host.removePlayer(playerId);
    await flush();

    expect(harness.hostRecorder.last('lobby')?.lobby.players).toHaveLength(1);
    expect(client.recorder.last('closed')?.reason).toBe('removedByHost');
    harness.destroy();
  });

  it('ignores a request to remove the host', async () => {
    const harness = await createHarness();
    harness.host.removePlayer(harness.host.localPlayerId);
    expect(harness.hostRecorder.last('lobby')?.lobby.players).toHaveLength(1);
    harness.destroy();
  });

  it('frees the seat when a lobby player leaves', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    client.session.destroy('leftVoluntarily');
    await flush();
    expect(harness.hostRecorder.last('lobby')?.lobby.players).toHaveLength(1);
    harness.destroy();
  });

  it('tells clients the room is gone when the host leaves', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    harness.host.destroy('leftVoluntarily');
    await flush();
    expect(client.recorder.last('closed')?.reason).toBe('hostLeft');
    client.session.destroy('leftVoluntarily');
  });

  it('needs at least two players to start', async () => {
    const harness = await createHarness();
    expect(harness.host.canStartGame()).toBe(false);
    harness.host.startGame();
    expect(harness.hostRecorder.ofType('publicState')).toHaveLength(0);

    await harness.addClient('Dana');
    expect(harness.host.canStartGame()).toBe(true);
    harness.destroy();
  });
});

describe('starting and playing a game', () => {
  it('deals private hands that only their owner receives', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    const hostHand = currentHand(harness.hostRecorder);
    const clientHand = currentHand(client.recorder);
    expect(hostHand).toHaveLength(8);
    expect(clientHand).toHaveLength(8);

    const hostIds = new Set(hostHand.map((card) => card.id));
    for (const card of clientHand) {
      expect(hostIds.has(card.id)).toBe(false);
    }

    // The client's public snapshot must not mention anyone else's cards.
    const snapshot = JSON.stringify(currentState(client.recorder));
    for (const card of hostHand) {
      expect(snapshot).not.toContain(card.id);
    }
    harness.destroy();
  });

  it('reports card counts publicly', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    const state = currentState(client.recorder);
    expect(state?.players.map((player) => player.cardCount)).toEqual([8, 8]);
    expect(state?.currentPlayerId).toBe(harness.host.localPlayerId);
    expect(state?.phase).toBe('playing');
    harness.destroy();
  });

  it('emits the same events to every player', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    const hostEvents = harness.hostRecorder.ofType('events').flatMap((update) => update.events);
    const clientEvents = client.recorder.ofType('events').flatMap((update) => update.events);
    expect(hostEvents.map((event) => event.type)).toEqual(['gameStarted', 'turnChanged']);
    expect(clientEvents.map((event) => event.type)).toEqual(['gameStarted', 'turnChanged']);
    harness.destroy();
  });

  it('applies a host action through the authoritative engine', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    const before = currentState(harness.hostRecorder)!;
    const card = pickLegalCard(harness.hostRecorder);
    if (!card) {
      harness.host.submitLocalAction({ type: 'drawCard' });
    } else {
      harness.host.submitLocalAction(
        card.kind === 'colorChange'
          ? { type: 'playCard', cardId: card.id, chosenColor: 'red' }
          : { type: 'playCard', cardId: card.id },
      );
    }
    await flush();

    const after = currentState(client.recorder)!;
    expect(after.version).toBeGreaterThan(before.version);
    harness.destroy();
  });

  it('rejects an action from the player who is not on turn', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    // The host always acts first, so the client is out of turn here.
    client.session.submitAction({ type: 'drawCard' });
    await flush();

    expect(client.recorder.last('actionRejected')?.code).toBe('notYourTurn');
    harness.destroy();
  });

  it('rejects an unknown card id', async () => {
    const harness = await createHarness();
    await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    harness.host.submitLocalAction({ type: 'playCard', cardId: 'not-a-real-card' });
    await flush();
    expect(harness.hostRecorder.last('actionRejected')?.code).toBe('cardNotInHand');
    harness.destroy();
  });

  it('never lets a client play a card it does not hold', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    // Pass the turn to the client first.
    harness.host.submitLocalAction({ type: 'drawCard' });
    await flush();

    const hostCard = currentHand(harness.hostRecorder)[0]!;
    client.session.submitAction({ type: 'playCard', cardId: hostCard.id });
    await flush();

    expect(client.recorder.last('actionRejected')?.code).toBe('cardNotInHand');
    harness.destroy();
  });

  it('refuses new joins once the game has started', async () => {
    const harness = await createHarness();
    await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    const late = await harness.addClient('Eli');
    await flush();
    expect(late.recorder.last('error')?.error.code).toBe('gameInProgress');
    harness.destroy();
  });
});

/** The seat that is not the host's, in a two-player harness. */
function otherPlayerId(state: PublicGameState, hostPlayerId: string): string {
  return state.players.find((player) => player.id !== hostPlayerId)?.id ?? '';
}

/**
 * Drives a full round through the real host/client stack: whoever is on turn
 * plays its first legal card, closes an open Taki sequence when nothing else is
 * legal, and otherwise draws. Whoever is down to a single card declares it, in or
 * out of turn — without that the round cannot be won at all, which is exactly the
 * rule. Deterministic thanks to the fixed seed.
 */
async function playUntilFinished(
  harness: Harness,
  client: { session: ClientSession; recorder: ReturnType<typeof createRecorder> },
  maxSteps = 600,
): Promise<PublicGameState> {
  for (let step = 0; step < maxSteps; step += 1) {
    const state = currentState(harness.hostRecorder);
    if (!state) {
      throw new Error('no public state');
    }
    if (state.phase === 'finished') {
      return state;
    }

    // A hand of one is declared before anything else happens, from either seat.
    const seats = [
      { id: harness.host.localPlayerId, recorder: harness.hostRecorder, host: true },
      { id: otherPlayerId(state, harness.host.localPlayerId), recorder: client.recorder, host: false },
    ];
    const undeclared = seats.find(
      (seat) => currentHand(seat.recorder).length === 1 && !state.declaredLastCard.includes(seat.id),
    );
    if (undeclared) {
      if (undeclared.host) {
        harness.host.submitLocalAction({ type: 'declareLastCard' });
      } else {
        client.session.submitAction({ type: 'declareLastCard' });
      }
      await flush(1);
      continue;
    }

    // An open +3 suspends the turn order: whoever holds a breaker answers first.
    if (state.plusThree) {
      const responder = seats.find(
        (candidate) =>
          candidate.id !== state.plusThree?.playerId &&
          currentHand(candidate.recorder).some((held) => held.kind === 'breakPlusThree'),
      );
      if (!responder) {
        throw new Error('a +3 is open with nobody able to answer it');
      }
      if (responder.host) {
        harness.host.submitLocalAction({ type: 'passBreak' });
      } else {
        client.session.submitAction({ type: 'passBreak' });
      }
      await flush(1);
      continue;
    }

    const hostIsOnTurn = state.currentPlayerId === harness.host.localPlayerId;
    const recorder = hostIsOnTurn ? harness.hostRecorder : client.recorder;
    const hand = currentHand(recorder);
    const context = playContextFromPublic(state);
    const card = hand.find((candidate) => isCardPlayable(candidate, context));

    let action: GameAction;
    if (card) {
      action =
        card.kind === 'colorChange'
          ? { type: 'playCard', cardId: card.id, chosenColor: 'green' }
          : { type: 'playCard', cardId: card.id };
    } else if (state.takiMode) {
      action = { type: 'closeTaki' };
    } else {
      action = { type: 'drawCard' };
    }

    if (hostIsOnTurn) {
      harness.host.submitLocalAction(action);
    } else {
      client.session.submitAction(action);
    }
    await flush(1);
  }
  throw new Error('round did not finish within the step budget');
}

describe('a full round through the session stack', () => {
  it('reaches a winner and reports final standings', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    const finished = await playUntilFinished(harness, client);
    expect(finished.phase).toBe('finished');
    expect(finished.winnerId).not.toBeNull();
    expect(finished.players.filter((player) => player.cardCount === 0)).toHaveLength(1);

    // Both sides agree on the outcome.
    await flush();
    expect(currentState(client.recorder)?.winnerId).toBe(finished.winnerId);
    harness.destroy();
  });

  it('starts a new round when every connected player agrees, without restarting versions', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    const finished = await playUntilFinished(harness, client);
    expect(harness.hostRecorder.last('playAgain')).toMatchObject({ required: 2 });

    harness.host.votePlayAgain(true);
    await flush();
    expect(currentState(harness.hostRecorder)?.phase).toBe('finished');
    expect(client.recorder.last('playAgain')?.agreed).toHaveLength(1);

    client.session.votePlayAgain(true);
    await flush();

    const fresh = currentState(harness.hostRecorder);
    expect(fresh?.phase).toBe('playing');
    expect(fresh!.version).toBeGreaterThan(finished.version);
    expect(currentHand(harness.hostRecorder)).toHaveLength(8);

    // The client must accept the new deal rather than dropping it as stale.
    const clientState = currentState(client.recorder);
    expect(clientState?.version).toBe(fresh?.version);
    expect(currentHand(client.recorder)).toHaveLength(8);
    harness.destroy();
  });

  it('ignores play-again votes while a round is still running', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    harness.host.startGame();
    await flush();

    harness.host.votePlayAgain(true);
    client.session.votePlayAgain(true);
    await flush();

    expect(currentState(harness.hostRecorder)?.phase).toBe('playing');
    harness.destroy();
  });
});

describe('reconnection', () => {
  it('restores the seat, the public state and the private hand', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    const identity = client.recorder.last('identity')!;
    harness.host.startGame();
    await flush();
    const handBefore = currentHand(client.recorder).map((card) => card.id);

    // Simulate a refresh: the old session goes away, a new one resumes.
    client.session.destroy('leftVoluntarily');
    await flush();
    expect(harness.hostRecorder.last('lobby')?.lobby.players[1]?.health).toBe('disconnected');

    const resumed = await harness.addClient('Dana', {
      playerId: identity.playerId,
      resumeToken: identity.resumeToken,
    });
    await flush();

    expect(resumed.recorder.last('identity')?.playerId).toBe(identity.playerId);
    expect(currentHand(resumed.recorder).map((card) => card.id)).toEqual(handBefore);
    expect(currentState(resumed.recorder)?.phase).toBe('playing');
    expect(harness.hostRecorder.last('lobby')?.lobby.players[1]?.health).toBe('connected');
    harness.destroy();
  });

  it('rejects a wrong resume token', async () => {
    const harness = await createHarness();
    const client = await harness.addClient('Dana');
    const identity = client.recorder.last('identity')!;
    harness.host.startGame();
    await flush();
    client.session.destroy('leftVoluntarily');
    await flush();

    const resumed = await harness.addClient('Dana', {
      playerId: identity.playerId,
      resumeToken: 'f'.repeat(32),
    });
    await flush();
    expect(resumed.recorder.last('error')?.error.code).toBe('invalidResumeToken');
    harness.destroy();
  });

  it('rejects a resume for an unknown seat', async () => {
    const harness = await createHarness();
    await harness.addClient('Dana');
    const resumed = await harness.addClient('Ghost', {
      playerId: 'pl_deadbeef',
      resumeToken: 'a'.repeat(32),
    });
    await flush();
    expect(resumed.recorder.last('error')?.error.code).toBe('unknownSeat');
    harness.destroy();
  });
});

describe('hostile and malformed traffic', () => {
  it('ignores malformed messages without dropping the room', async () => {
    const harness = await createHarness();
    const attacker = createScriptedPeer(harness.network, 'attacker');
    await attacker.connectTo(HOST_PEER_ID);
    await flush();

    attacker.send('not an object');
    attacker.send({ type: 'joinRequest' });
    attacker.send(attacker.envelope('joinRequest', { displayName: '' }));
    attacker.send(attacker.envelope('takeOverHost', {}));
    await flush();

    expect(harness.hostRecorder.last('lobby')?.lobby.players).toHaveLength(1);
    attacker.close();
    harness.destroy();
  });

  it('answers a protocol mismatch with a clear rejection', async () => {
    const harness = await createHarness();
    const attacker = createScriptedPeer(harness.network, 'attacker');
    await attacker.connectTo(HOST_PEER_ID);
    attacker.send(attacker.envelope('joinRequest', { displayName: 'Dana' }, { protocolVersion: 999 }));
    await flush();
    expect(attacker.ofType('joinRejected')[0]?.payload).toMatchObject({ reason: 'protocolMismatch' });
    attacker.close();
    harness.destroy();
  });

  it('ignores messages addressed to another room', async () => {
    const harness = await createHarness();
    const attacker = createScriptedPeer(harness.network, 'attacker');
    await attacker.connectTo(HOST_PEER_ID);
    attacker.send(attacker.envelope('joinRequest', { displayName: 'Dana' }, { roomId: 'OTHER-ROOM-11' }));
    await flush();
    expect(harness.hostRecorder.last('lobby')?.lobby.players).toHaveLength(1);
    attacker.close();
    harness.destroy();
  });

  it('drops a replayed message id', async () => {
    const harness = await createHarness();
    const attacker = createScriptedPeer(harness.network, 'attacker');
    await attacker.connectTo(HOST_PEER_ID);

    const join = attacker.envelope('joinRequest', { displayName: 'Dana' });
    attacker.send(join);
    await flush();
    attacker.send(join);
    await flush();

    expect(harness.hostRecorder.last('lobby')?.lobby.players).toHaveLength(2);
    expect(attacker.ofType('joinAccepted')).toHaveLength(1);
    attacker.close();
    harness.destroy();
  });

  it('closes the older channel when the same peer connects twice', async () => {
    const harness = await createHarness();
    const peer = createScriptedPeer(harness.network, 'twin');
    const first = await peer.connectTo(HOST_PEER_ID);
    await flush();
    await peer.connectTo(HOST_PEER_ID);
    await flush();

    expect(first.open).toBe(false);
    peer.close();
    harness.destroy();
  });

  it('ignores an action from a peer that never joined', async () => {
    const harness = await createHarness();
    await harness.addClient('Dana');
    harness.host.startGame();
    await flush();
    const versionBefore = currentState(harness.hostRecorder)!.version;

    const attacker = createScriptedPeer(harness.network, 'attacker');
    await attacker.connectTo(HOST_PEER_ID);
    attacker.send(attacker.envelope('action', { action: { type: 'drawCard' } }));
    await flush();

    expect(currentState(harness.hostRecorder)!.version).toBe(versionBefore);
    attacker.close();
    harness.destroy();
  });
});
