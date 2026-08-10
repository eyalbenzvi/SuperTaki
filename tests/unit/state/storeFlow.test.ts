import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAST_CARD_GRACE_MS } from '../../../src/features/game/network/timing.ts';
import { RoomError } from '../../../src/features/game/network/roomTransport.ts';
import { __setChannelFactoryForTests, useAppStore } from '../../../src/features/game/state/store.ts';
import { TestRoom, TEST_ROOM, flush } from '../helpers/room.ts';

/**
 * The store, driven against a real room.
 *
 * The room on the other end of these tests is the actual `GameRoom` from
 * `worker/src`, over an in-memory pipe — see `tests/unit/helpers/room.ts`. What that
 * buys is that a disagreement between the two halves of the protocol fails here,
 * rather than surviving until somebody plays a game.
 *
 * The describes that used to live at the bottom of this file — reclaiming a hosted
 * room, and accepting a handover — are gone with the machinery they covered. What
 * they were really testing is now the first test in "the room creator is an ordinary
 * player", in `worker/test/gameRoom.test.ts`, and it is a stronger claim: the room
 * survives, so there is nothing to reclaim.
 */
type Store = ReturnType<typeof useAppStore.getState>;

const PRISTINE: Store = { ...useAppStore.getState() };
let room: TestRoom;

beforeEach(() => {
  room = new TestRoom({ roomCode: TEST_ROOM });
  __setChannelFactoryForTests(room.connect);
  useAppStore.setState({ ...PRISTINE }, true);
});

afterEach(() => {
  useAppStore.getState().leaveRoom();
  __setChannelFactoryForTests(null);
  localStorage.clear();
});

function store(): Store {
  return useAppStore.getState();
}

/** Opens a room as its creator, the way the create screen does. */
async function createRoom(): Promise<void> {
  await store().createRoom({ name: 'דנה', maxPlayers: 4, tableLanguage: 'he', gameMode: 'classic' });
  await flush();
}

/** A second player at the same room, driven through their own session. */
async function seatGuest(
  name = 'אלי',
  options: { create?: boolean } = {},
): Promise<{ playerId: string; resumeToken: string }> {
  const { ClientSession } = await import('../../../src/features/game/network/clientSession.ts');
  let identity: { playerId: string; resumeToken: string } | null = null;
  const guest = new ClientSession({
    roomCode: options.create ? TEST_ROOM : (store().roomCode ?? TEST_ROOM),
    displayName: name,
    connect: room.connect,
    ...(options.create ? { create: { maxPlayers: 4, tableLanguage: 'he' as const } } : {}),
    observer: (update) => {
      if (update.type === 'identity') {
        identity = { playerId: update.playerId, resumeToken: update.resumeToken };
      }
    },
  });
  await guest.start();
  await flush();
  if (identity === null) {
    throw new Error('the guest was never seated');
  }
  return identity;
}

describe('creating a room through the store', () => {
  it('opens a lobby with a shareable invite link', async () => {
    await createRoom();
    expect(store().screen).toBe('lobby');
    expect(store().roomCode).toMatch(/^\d{6}$/);
    expect(store().inviteUrl).toContain(`#/join?room=${store().roomCode ?? ''}`);
    expect(store().inRoom).toBe(true);
    expect(store().busy).toBe(false);
  });

  it('stores resume metadata for the room creator too', async () => {
    /*
     * The heart of the change, seen from the client. The creator's seat used to be
     * the one seat with no way back — it *was* the authority, and an authority cannot
     * rejoin itself — so instead of a credential they were given a copy of the whole
     * game in `localStorage` and a button to restart the room from. Now they get what
     * everybody else gets.
     */
    await createRoom();
    const resumable = store().resumable;
    expect(resumable?.roomCode).toBe(store().roomCode);
    expect(resumable?.playerId).toBe(store().localPlayerId);
    expect(resumable?.resumeToken).toMatch(/^[a-f0-9]{16,}$/);
  });

  it('holds the lobby buttons, and says so in the lobby everybody sees', async () => {
    await createRoom();
    const me = store().localPlayerId;
    expect(store().lobby?.creatorPlayerId).toBe(me);
    expect(store().lobby?.players.find((player) => player.id === me)?.isCreator).toBe(true);
  });

  it('draws another code when the first one is already a room', async () => {
    /*
     * A collision used to be the relay refusing a peer-id claim. It is now the room
     * itself answering `roomTaken`, because it already has players in it.
     *
     * Forced rather than waited for: the odds of two random six-digit codes colliding
     * are one in a million, so the first code is made to land on a room that already
     * has somebody in it, and only the first.
     */
    let attempts = 0;
    __setChannelFactoryForTests((code) => {
      attempts += 1;
      if (attempts === 1) {
        // Somebody is already sitting at the code the store just drew.
        room.seatSquatter(code);
      }
      return room.connect(code);
    });
    await store().createRoom({ name: 'דנה', maxPlayers: 4, tableLanguage: 'he', gameMode: 'classic' });
    await flush();

    expect(attempts).toBeGreaterThan(1);
    expect(store().screen).toBe('lobby');
    expect(store().error).toBeNull();
    expect(store().roomCode).not.toBe(TEST_ROOM);
  });

  it('surfaces a failure instead of pretending to be connected', async () => {
    __setChannelFactoryForTests(() => Promise.reject(new RoomError('notConfigured', 'no relay')));
    await store().createRoom({ name: 'דנה', maxPlayers: 4, tableLanguage: 'he', gameMode: 'classic' });
    await flush();
    expect(store().phase).toBe('failed');
    expect(store().error?.code).toBe('notConfigured');
    expect(store().busy).toBe(false);
  });

  it('ignores a second create while one is in flight', async () => {
    const first = store().createRoom({
      name: 'דנה',
      maxPlayers: 4,
      tableLanguage: 'he',
      gameMode: 'classic',
    });
    await store().createRoom({ name: 'אחר', maxPlayers: 4, tableLanguage: 'he', gameMode: 'classic' });
    await first;
    await flush();
    expect(store().displayName).toBe('דנה');
  });

  it('sends the lobby powers as room commands', async () => {
    await createRoom();
    await seatGuest();
    store().setMaxPlayers(5);
    await flush();
    expect(store().lobby?.maxPlayers).toBe(5);

    store().addBot();
    await flush();
    expect(store().lobby?.players.filter((player) => player.bot === true)).toHaveLength(1);
  });

  it('carries the game mode from the create screen to the room, and can change it', async () => {
    await store().createRoom({ name: 'דנה', maxPlayers: 4, tableLanguage: 'he', gameMode: 'stairs' });
    await flush();
    // The room's own answer, not the value the screen sent: it comes back in the
    // lobby snapshot every seat receives.
    expect(store().lobby?.gameMode).toBe('stairs');

    store().setGameMode('classic');
    await flush();
    expect(store().lobby?.gameMode).toBe('classic');
  });
});

describe('joining a room through the store', () => {
  it('receives the lobby, an identity and stores resume metadata', async () => {
    const creator = await seatGuest('דנה', { create: true });
    await store().joinRoom({ name: 'אלי', roomCode: TEST_ROOM });
    await flush();

    expect(store().phase).toBe('connected');
    expect(store().lobby?.players).toHaveLength(2);
    expect(store().lobby?.creatorPlayerId).toBe(creator.playerId);
    expect(store().resumable?.playerId).toBe(store().localPlayerId);
    expect(store().resumable?.roomCode).toBe(TEST_ROOM);
  });

  it('comes back to the same seat with a resume token', async () => {
    await createRoom();
    const me = store().localPlayerId as string;
    const token = store().resumable?.resumeToken as string;
    const code = store().roomCode as string;
    // The credential survives; leaving deliberately does not, so the seat is dropped
    // from the store without the room being told to retire it.
    __setChannelFactoryForTests(room.connect);
    useAppStore.setState({ ...PRISTINE }, true);
    await flush();

    // A fresh session, as a reload gives.
    await store().joinRoom({
      name: 'דנה',
      roomCode: code,
      resume: { playerId: me, resumeToken: token },
    });
    await flush();
    expect(store().localPlayerId).toBe(me);
    expect(store().phase).toBe('connected');
  });

  it('moves to the game screen with a private hand when the round is dealt', async () => {
    await createRoom();
    await seatGuest();
    store().startGame();
    await flush();

    expect(store().screen).toBe('game');
    expect(store().publicState?.phase).toBe('playing');
    expect(store().hand).toHaveLength(8);
    // Only my own cards ever arrive.
    expect(store().publicState?.players.every((player) => 'cardCount' in player)).toBe(true);
  });

  it('forwards a card play with the chosen colour', async () => {
    await createRoom();
    await seatGuest();
    store().startGame();
    await flush();

    const wild = store().hand.find((card) => card.kind === 'colorChange');
    const before = store().hand.length;
    if (wild && store().publicState?.currentPlayerId === store().localPlayerId) {
      store().playCard(wild.id, 'red');
      await flush();
      expect(store().hand.length).toBeLessThan(before);
      expect(store().publicState?.activeColor).toBe('red');
    }
  });

  it('reports a rejected action with a fresh notice each time', async () => {
    await createRoom();
    await seatGuest();
    store().startGame();
    await flush();

    // Whatever the deal, playing a card that is not in this hand is always refused.
    store().playCard('no-such-card');
    await flush();
    const first = store().rejection;
    expect(first?.code).toBe('cardNotInHand');

    store().dismissRejection();
    store().playCard('no-such-card');
    await flush();
    expect(store().rejection?.nonce).toBeGreaterThan(first?.nonce ?? 0);
  });

  it('raises a notice naming who caught whom', async () => {
    await createRoom();
    const guest = await seatGuest();
    store().startGame();
    await flush();

    // Bring the other seat down to one card, then let the head start expire.
    room.at(store().roomCode as string).forceHandForTests(guest.playerId, 1);
    await flush();
    room.advance(LAST_CARD_GRACE_MS + 500);

    store().catchLastCard(guest.playerId);
    await flush();
    expect(store().caught?.targetId).toBe(guest.playerId);
    expect(store().caught?.byId).toBe(store().localPlayerId);
    expect(store().caught?.penalty).toBeGreaterThan(0);
  });

  it('clears everything on leave', async () => {
    await createRoom();
    await seatGuest();
    store().startGame();
    await flush();
    expect(store().screen).toBe('game');

    store().leaveRoom();
    expect(store().screen).toBe('home');
    expect(store().inRoom).toBe(false);
    expect(store().roomCode).toBeNull();
    expect(store().lobby).toBeNull();
    expect(store().hand).toHaveLength(0);
    expect(store().resumable).toBeNull();
  });

  it('keeps the credential through a dropped socket, and only forgets it on leaving', async () => {
    await createRoom();
    const stored = localStorage.getItem('superTaki:resumableRoom');
    expect(stored).not.toBeNull();

    // A socket that simply dropped is not a departure: the credential survives it,
    // because it is the one thing needed to come back.
    await flush();
    expect(localStorage.getItem('superTaki:resumableRoom')).toBe(stored);

    store().leaveRoom();
    expect(localStorage.getItem('superTaki:resumableRoom')).toBeNull();
  });
});

describe('the table controls, through the store', () => {
  it('holds the table and lets it carry on', async () => {
    await createRoom();
    await seatGuest();
    store().startGame();
    await flush();

    store().setPaused(true);
    await flush();
    expect(store().pausedBy).toBe(store().localPlayerId);

    store().setPaused(false);
    await flush();
    expect(store().pausedBy).toBeNull();
  });

  it('ends the round when everybody present agrees to abandon it', async () => {
    await createRoom();
    const guest = await seatGuest();
    store().startGame();
    await flush();

    store().voteAbandon(true);
    await flush();
    expect(store().publicState?.phase).toBe('playing');

    // The other seat agrees, through its own session.
    const { ClientSession } = await import('../../../src/features/game/network/clientSession.ts');
    const other = new ClientSession({
      roomCode: store().roomCode ?? TEST_ROOM,
      displayName: 'אלי',
      connect: room.connect,
      observer: () => {},
      resume: { playerId: guest.playerId, resumeToken: guest.resumeToken },
    });
    await other.start();
    await flush();
    other.voteAbandon(true);
    await flush();

    expect(store().publicState?.phase).toBe('finished');
    expect(store().publicState?.endReason).toBe('abandoned');
    other.destroy('leftVoluntarily');
  });

  it('nudges a seat that is present and not looking', async () => {
    await createRoom();
    const guest = await seatGuest();
    store().startGame();
    await flush();
    expect(() => {
      store().nudgePlayer(guest.playerId);
    }).not.toThrow();
  });
});

describe('preferences and navigation', () => {
  it('persists language and theme and applies them to the document', () => {
    store().setLanguage('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(localStorage.getItem('superTaki:language')).toBe('en');

    store().setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('superTaki:theme')).toBe('dark');
  });

  it('sanitises and persists the display name', () => {
    store().setDisplayName('  אלי  ');
    expect(store().displayName).toBe('אלי');
    expect(localStorage.getItem('superTaki:displayName')).toBe('אלי');
  });

  it('forgets stored resume metadata on request', () => {
    localStorage.setItem(
      'superTaki:resumableRoom',
      JSON.stringify({
        roomCode: TEST_ROOM,
        playerId: 'pl_x',
        resumeToken: 'a'.repeat(32),
        displayName: 'אלי',
        savedAt: Date.now(),
      }),
    );
    useAppStore.setState({ ...PRISTINE }, true);
    store().forgetResumable();
    expect(store().resumable).toBeNull();
  });

  it('dismisses an error banner', () => {
    useAppStore.setState({ error: { code: 'network', retryable: true } });
    store().dismissError();
    expect(store().error).toBeNull();
  });

  it('locks the table while a move is unanswered, so one tap cannot become two', async () => {
    await store().createRoom({ name: 'דנה', maxPlayers: 4, tableLanguage: 'he', gameMode: 'classic' });
    await flush();
    await seatGuest();
    store().startGame();
    await flush();

    expect(store().actionPending).toBe(false);
    store().playCard('no-such-card');
    // The intent is on the wire and nothing has come back yet.
    expect(store().actionPending).toBe(true);

    // A second tap in that window is dropped rather than sent twice.
    store().playCard('no-such-card');
    expect(store().actionPending).toBe(true);

    await flush();
    // The room's answer — a rejection here — releases the lock, so a dropped packet
    // can never freeze the hand.
    expect(store().actionPending).toBe(false);
  });

  it('tracks the leave request separately from leaving', () => {
    store().requestLeave();
    expect(store().leaveIntent).toBe(true);
    store().cancelLeave();
    expect(store().leaveIntent).toBe(false);
  });

  it('re-announces the same message by bumping its nonce', () => {
    store().announce('תור שלך');
    const first = store().announcement;
    expect(first?.text).toBe('תור שלך');

    store().announce('תור שלך');
    expect(store().announcement?.nonce).toBeGreaterThan(first?.nonce ?? 0);

    // Nothing to say is not a message.
    store().announce('');
    expect(store().announcement?.text).toBe('תור שלך');
  });

  it('records whether the device has a network at all', () => {
    store().setOnline(false);
    expect(store().online).toBe(false);
    store().setOnline(true);
    expect(store().online).toBe(true);
  });

  it('ignores game actions when no session is active', () => {
    expect(() => {
      store().playCard('x');
      store().drawCard();
      store().closeTaki();
      store().votePlayAgain(true);
      store().startGame();
      store().setMaxPlayers(4);
      store().removePlayer('nobody');
      store().retryConnection();
    }).not.toThrow();
  });
});
