import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame } from '../../../src/features/game/engine/engine.ts';
import { toPrivateHandView, toPublicGameState } from '../../../src/features/game/engine/views.ts';
import type { PublicGameState } from '../../../src/features/game/engine/views.ts';
import { MemoryNetwork } from '../../../src/features/game/network/memoryTransport.ts';
import { hostPeerIdForRoom } from '../../../src/features/game/network/roomCode.ts';
import { tableSignature } from '../../../src/features/game/state/beat.ts';
import { useAppStore } from '../../../src/features/game/state/store.ts';
import { TEST_ROOM, createScriptedPeer, flush } from '../helpers/net.ts';

/**
 * The beat is the presentation layer's only view of "what just happened".
 *
 * It is driven here through the real store over the in-memory transport, with a
 * hand-written peer standing in for the host, because the property that matters
 * is a property of the *arrival order*: the public state, the hand and the event
 * batch reach a client as three separate messages, and the beat has to be minted
 * exactly once, when the last of them lands, carrying the table from before the
 * first. Writing the field directly would prove none of that.
 */
const holder = vi.hoisted(() => ({ create: null as ((id?: string) => unknown) | null }));

vi.mock('../../../src/features/game/network/transportFactory.ts', () => ({
  readTransportKind: () => 'memory',
  createTransport: (options: { id?: string } = {}) => {
    if (!holder.create) {
      throw new Error('test transport not installed');
    }
    return holder.create(options.id);
  },
}));

type Store = ReturnType<typeof useAppStore.getState>;
const PRISTINE: Store = { ...useAppStore.getState() };

const HOST_PEER = hostPeerIdForRoom(TEST_ROOM);
const ME = 'pl_client000';
const THEM = 'pl_host00000';

let network: MemoryNetwork;

beforeEach(() => {
  network = new MemoryNetwork();
  holder.create = (id?: string) => network.create(id);
  useAppStore.setState({ ...PRISTINE }, true);
});

function store(): Store {
  return useAppStore.getState();
}

const lobby = {
  roomCode: TEST_ROOM,
  hostPeerId: HOST_PEER,
  hostPlayerId: THEM,
  maxPlayers: 4,
  phase: 'inGame' as const,
  tableLanguage: 'he' as const,
  players: [
    { id: THEM, name: 'Dana', isHost: true, health: 'connected' as const, seat: 0 },
    { id: ME, name: 'Bob', isHost: false, health: 'connected' as const, seat: 1 },
  ],
};

/** A real dealt game, so every payload below satisfies the wire schema. */
function dealt(): { publicState: PublicGameState; cards: ReturnType<typeof toPrivateHandView>['cards'] } {
  const result = createGame(
    [
      { id: THEM, name: 'Dana' },
      { id: ME, name: 'Bob' },
    ],
    31337,
  );
  if (!result.ok) {
    throw new Error('fixture failed');
  }
  return {
    publicState: toPublicGameState(result.state),
    cards: toPrivateHandView(result.state, ME).cards,
  };
}

async function joinScriptedHost(): Promise<ReturnType<typeof createScriptedPeer>> {
  const host = createScriptedPeer(network, HOST_PEER);
  await store().joinRoom({ name: 'Bob', roomCode: TEST_ROOM });
  await flush();
  host.send(
    host.envelope('joinAccepted', {
      playerId: ME,
      resumeToken: 'b'.repeat(32),
      displayName: 'Bob',
      lobby,
    }),
  );
  await flush();
  return host;
}

/** Sends one accepted command the way a host does: state, then hand, then events. */
async function sendMove(
  host: ReturnType<typeof createScriptedPeer>,
  publicState: PublicGameState,
  cards: ReturnType<typeof toPrivateHandView>['cards'],
  events: readonly Record<string, unknown>[],
): Promise<void> {
  host.send(host.envelope('publicState', { state: publicState }));
  host.send(host.envelope('privateHand', { hand: { version: publicState.version, playerId: ME, cards } }));
  host.send(host.envelope('gameEvents', { version: publicState.version, events }));
  await flush();
}

describe('the beat', () => {
  it('is part of the pristine state, so a reset store still has the field', () => {
    // The component tests' `resetStore` replaces state wholesale, so a field
    // declared anywhere but `initialState` vanishes in every one of them.
    expect('beat' in PRISTINE).toBe(true);
    expect(PRISTINE.beat).toBeNull();
  });

  it('reduces a public state and hand to a signature of what motion cares about', () => {
    const { publicState, cards } = dealt();
    const signature = tableSignature(publicState, cards);

    expect(signature.version).toBe(publicState.version);
    expect(signature.discardTopId).toBe(publicState.discardTop?.id ?? null);
    expect(signature.drawPileCount).toBe(publicState.drawPileCount);
    expect(signature.activeColor).toBe(publicState.activeColor);
    expect(signature.direction).toBe(publicState.direction);
    expect(signature.currentPlayerId).toBe(publicState.currentPlayerId);
    expect(signature.handIds).toEqual(cards.map((card) => card.id));
    // Every seat is counted, so a draw can be attributed to the seat that grew.
    expect(signature.counts).toEqual({ [THEM]: 8, [ME]: 8 });
  });

  it('signs an empty discard pile without inventing a card', () => {
    const { publicState, cards } = dealt();
    const empty = tableSignature({ ...publicState, discardTop: null }, cards);
    expect(empty.discardTopId).toBeNull();
  });

  it('is minted when the events land, not when the state does', async () => {
    const host = await joinScriptedHost();
    const { publicState, cards } = dealt();

    host.send(host.envelope('publicState', { state: publicState }));
    await flush();
    // The table has already moved on screen, and nothing yet knows why.
    expect(store().publicState?.version).toBe(publicState.version);
    expect(store().beat).toBeNull();

    host.send(host.envelope('privateHand', { hand: { version: publicState.version, playerId: ME, cards } }));
    await flush();
    expect(store().beat).toBeNull();

    host.send(
      host.envelope('gameEvents', {
        version: publicState.version,
        events: [{ type: 'gameStarted', firstPlayerId: THEM, activeColor: publicState.activeColor }],
      }),
    );
    await flush();

    const beat = store().beat;
    expect(beat).not.toBeNull();
    expect(beat?.events).toHaveLength(1);
    expect(beat?.to.version).toBe(publicState.version);
    // No table existed before the deal, so there is nothing to have come from.
    expect(beat?.from).toBeNull();
    host.close();
  });

  it('carries the table from before the command and after it', async () => {
    const host = await joinScriptedHost();
    const { publicState, cards } = dealt();
    await sendMove(host, publicState, cards, [
      { type: 'gameStarted', firstPlayerId: THEM, activeColor: publicState.activeColor },
    ]);
    const first = store().beat;
    expect(first?.from).toBeNull();

    // A second command: one card leaves the opponent's hand for the pile.
    const next: PublicGameState = {
      ...publicState,
      version: publicState.version + 1,
      currentPlayerId: ME,
      drawPileCount: publicState.drawPileCount - 1,
      players: publicState.players.map((player) =>
        player.id === THEM ? { ...player, cardCount: player.cardCount - 1 } : player,
      ),
    };
    await sendMove(host, next, cards, [{ type: 'turnChanged', playerId: ME }]);

    const beat = store().beat;
    expect(beat?.seq).toBe((first?.seq ?? 0) + 1);
    // `from` is the table as it stood a moment ago, which is the whole point:
    // it is the only instant at which the previous state can still be had.
    expect(beat?.from?.version).toBe(publicState.version);
    expect(beat?.from?.currentPlayerId).toBe(THEM);
    expect(beat?.from?.counts[THEM]).toBe(8);
    expect(beat?.to.version).toBe(next.version);
    expect(beat?.to.currentPlayerId).toBe(ME);
    expect(beat?.to.counts[THEM]).toBe(7);
    host.close();
  });

  it('is not minted twice by a host replaying its log at the same version', async () => {
    const host = await joinScriptedHost();
    const { publicState, cards } = dealt();
    const events = [{ type: 'gameStarted', firstPlayerId: THEM, activeColor: publicState.activeColor }];
    await sendMove(host, publicState, cards, events);
    const first = store().beat;
    expect(first).not.toBeNull();

    /*
     * The client only drops an event batch whose version is strictly older, so a
     * replay at the version already seen reaches the store intact — which is why
     * the guard has to live there. The feed dedupes nothing here either; what is
     * asserted is that no *second* beat is minted for one accepted command.
     */
    host.send(host.envelope('gameEvents', { version: publicState.version, events }));
    await flush();

    expect(store().beat?.seq).toBe(first?.seq);
    host.close();
  });

  it('never reuses a sequence number, and never assumes it starts at one', async () => {
    const host = await joinScriptedHost();
    const { publicState, cards } = dealt();
    const seen: number[] = [];

    for (let index = 0; index < 4; index += 1) {
      const state: PublicGameState = { ...publicState, version: publicState.version + index };
      await sendMove(host, state, cards, [{ type: 'turnChanged', playerId: index % 2 === 0 ? ME : THEM }]);
      const seq = store().beat?.seq;
      expect(seq).toBeDefined();
      seen.push(seq ?? 0);
    }

    // Strictly increasing. Not "starts at 1": the counter is module-level and
    // survives a store reset, exactly like the feed's ids.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    host.close();
  });

  it('is cleared when the round it belongs to is cleared', async () => {
    const host = await joinScriptedHost();
    const { publicState, cards } = dealt();
    await sendMove(host, publicState, cards, [
      { type: 'gameStarted', firstPlayerId: THEM, activeColor: publicState.activeColor },
    ]);
    expect(store().beat).not.toBeNull();

    store().leaveRoom();
    await flush(1);
    expect(store().beat).toBeNull();
    host.close();
  });

  it('does not carry a from across a round boundary', async () => {
    const host = await joinScriptedHost();
    const { publicState, cards } = dealt();
    await sendMove(host, publicState, cards, [
      { type: 'gameStarted', firstPlayerId: THEM, activeColor: publicState.activeColor },
    ]);
    expect(store().beat?.to.version).toBe(publicState.version);
    host.close();

    // A fresh room resets the tracking, so the first beat of the next round has
    // no "before" belonging to the last one and its version check starts clean.
    await store().createRoom({ name: 'Dana', maxPlayers: 2, tableLanguage: 'he' });
    expect(store().beat).toBeNull();
    store().leaveRoom();
    await flush(1);
  });
});
