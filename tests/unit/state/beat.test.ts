import { beforeEach, describe, expect, it } from 'vitest';
import { createGame } from '../../../src/features/game/engine/engine.ts';
import { toPrivateHandView, toPublicGameState } from '../../../src/features/game/engine/views.ts';
import type { PublicGameState } from '../../../src/features/game/engine/views.ts';
import type { GameEvent } from '../../../src/features/game/engine/state.ts';
import { __setChannelFactoryForTests, useAppStore } from '../../../src/features/game/state/store.ts';
import { ScriptedRoom, TEST_ROOM, flush } from '../helpers/room.ts';

/**
 * The beat is the presentation layer's only view of "what just happened".
 *
 * It is driven here through the real store over the in-memory transport, with a
 * hand-written peer standing in for the host, because the property that matters is
 * a property of the *arrival order*: the public state, the hand and the event batch
 * reach a client as three separate messages, and the beat has to be minted exactly
 * once, when the last of them lands. Writing the field directly would prove none of
 * that.
 */
type Store = ReturnType<typeof useAppStore.getState>;
const PRISTINE: Store = { ...useAppStore.getState() };

const ME = 'pl_client000';
const THEM = 'pl_host00000';

let room: ScriptedRoom;

beforeEach(() => {
  room = new ScriptedRoom(TEST_ROOM);
  __setChannelFactoryForTests(room.connect);
  useAppStore.setState({ ...PRISTINE }, true);
});

function store(): Store {
  return useAppStore.getState();
}

const lobby = {
  roomCode: TEST_ROOM,
  creatorPlayerId: THEM,
  maxPlayers: 4,
  phase: 'inGame' as const,
  tableLanguage: 'he' as const,
  players: [
    { id: THEM, name: 'Dana', isCreator: true, health: 'connected' as const, seat: 0 },
    { id: ME, name: 'Bob', isCreator: false, health: 'connected' as const, seat: 1 },
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

async function joinScriptedHost(): Promise<ScriptedRoom> {
  // Started, not awaited: `joinRoom` now waits for the room's answer, and in this
  // file the room is scripted — the answer is the next line.
  const joining = store().joinRoom({ name: 'Bob', roomCode: TEST_ROOM });
  await flush();
  room.say('joinAccepted', {
    playerId: ME,
    resumeToken: 'b'.repeat(32),
    displayName: 'Bob',
    lobby,
  });
  await joining;
  await flush();
  return room;
}

/** Sends one accepted command the way a host does: state, then hand, then events. */
async function sendMove(
  publicState: PublicGameState,
  cards: ReturnType<typeof toPrivateHandView>['cards'],
  events: readonly GameEvent[],
): Promise<void> {
  room.say('publicState', { state: publicState });
  room.say('privateHand', { hand: { version: publicState.version, playerId: ME, cards } });
  room.say('gameEvents', { version: publicState.version, events });
  await flush();
}

describe('the beat', () => {
  it('is part of the pristine state, so a reset store still has the field', () => {
    // The component tests' `resetStore` replaces state wholesale, so a field
    // declared anywhere but `initialState` vanishes in every one of them.
    expect('beat' in PRISTINE).toBe(true);
    expect(PRISTINE.beat).toBeNull();
  });

  it('is minted when the events land, not when the state does', async () => {
    await joinScriptedHost();
    const { publicState, cards } = dealt();

    room.say('publicState', { state: publicState });
    await flush();
    // The table has already moved on screen, and nothing yet knows why.
    expect(store().publicState?.version).toBe(publicState.version);
    expect(store().beat).toBeNull();

    room.say('privateHand', { hand: { version: publicState.version, playerId: ME, cards } });
    await flush();
    expect(store().beat).toBeNull();

    room.say('gameEvents', {
      version: publicState.version,
      events: [{ type: 'gameStarted', firstPlayerId: THEM, activeColor: publicState.activeColor }],
    });
    await flush();

    const beat = store().beat;
    expect(beat).not.toBeNull();
    expect(beat?.events).toHaveLength(1);
    room.dropAll();
  });

  it('is one beat per accepted command, in order', async () => {
    await joinScriptedHost();
    const { publicState, cards } = dealt();
    await sendMove(publicState, cards, [
      { type: 'gameStarted', firstPlayerId: THEM, activeColor: publicState.activeColor },
    ]);
    const first = store().beat;
    expect(first?.events).toHaveLength(1);

    const next: PublicGameState = {
      ...publicState,
      version: publicState.version + 1,
      currentPlayerId: ME,
    };
    await sendMove(next, cards, [{ type: 'turnChanged', playerId: ME }]);

    const beat = store().beat;
    expect(beat?.seq).toBe((first?.seq ?? 0) + 1);
    expect(beat?.events).toEqual([{ type: 'turnChanged', playerId: ME }]);
    room.dropAll();
  });

  it('is not minted twice by a host replaying its log at the same version', async () => {
    await joinScriptedHost();
    const { publicState, cards } = dealt();
    const events: GameEvent[] = [
      { type: 'gameStarted', firstPlayerId: THEM, activeColor: publicState.activeColor },
    ];
    await sendMove(publicState, cards, events);
    const first = store().beat;
    expect(first).not.toBeNull();

    /*
     * The client only drops an event batch whose version is strictly older, so a
     * replay at the version already seen reaches the store intact — which is why
     * the guard has to live there. The feed dedupes nothing here either; what is
     * asserted is that no *second* beat is minted for one accepted command.
     */
    room.say('gameEvents', { version: publicState.version, events });
    await flush();

    expect(store().beat?.seq).toBe(first?.seq);
    room.dropAll();
  });

  it('never reuses a sequence number, and never assumes it starts at one', async () => {
    await joinScriptedHost();
    const { publicState, cards } = dealt();
    const seen: number[] = [];

    for (let index = 0; index < 4; index += 1) {
      const state: PublicGameState = { ...publicState, version: publicState.version + index };
      await sendMove(state, cards, [{ type: 'turnChanged', playerId: index % 2 === 0 ? ME : THEM }]);
      const seq = store().beat?.seq;
      expect(seq).toBeDefined();
      seen.push(seq ?? 0);
    }

    // Strictly increasing. Not "starts at 1": the counter is module-level and
    // survives a store reset, exactly like the feed's ids.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    room.dropAll();
  });

  it('is cleared when the round it belongs to is cleared', async () => {
    await joinScriptedHost();
    const { publicState, cards } = dealt();
    await sendMove(publicState, cards, [
      { type: 'gameStarted', firstPlayerId: THEM, activeColor: publicState.activeColor },
    ]);
    expect(store().beat).not.toBeNull();

    store().leaveRoom();
    await flush(1);
    expect(store().beat).toBeNull();
    room.dropAll();
  });

  it('does not carry a from across a round boundary', async () => {
    await joinScriptedHost();
    const { publicState, cards } = dealt();
    await sendMove(publicState, cards, [
      { type: 'gameStarted', firstPlayerId: THEM, activeColor: publicState.activeColor },
    ]);
    expect(store().beat?.events).toHaveLength(1);
    room.dropAll();

    /*
     * A fresh room resets the tracking, so the first beat of the next round has no
     * "before" belonging to the last one and its version check starts clean.
     *
     * The scripted room never answers a join, so the create is not awaited: what is
     * being asserted is that asking for one clears the beat, which happens before any
     * answer could arrive.
     */
    void store().createRoom({ name: 'Dana', maxPlayers: 2, tableLanguage: 'he', gameMode: 'classic' });
    await flush(1);
    expect(store().beat).toBeNull();
    store().leaveRoom();
    await flush(1);
  });
});
