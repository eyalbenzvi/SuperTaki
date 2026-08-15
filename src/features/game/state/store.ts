import { create } from 'zustand';
import { DEFAULT_LANGUAGE, directionFor, type Language } from '../../../i18n/index.ts';
import { releaseSound, setSoundEnabled, unlockSound } from '../../../lib/audio.ts';
import { createLogger } from '../../../lib/logger.ts';
import { sanitizeDisplayName } from '../../../lib/sanitize.ts';
import type { Card } from '../engine/cards.ts';
import type { AssistLevel } from '../engine/assist.ts';
import type { GameEvent, GameMode, RejectionCode } from '../engine/state.ts';
import type { PublicGameState } from '../engine/views.ts';
import { ClientSession } from '../network/clientSession.ts';
import type { ChannelFactory } from '../network/roomTransport.ts';
import type { AssistSettings, GameAction, LobbySnapshot, RoomCommand } from '../network/protocol.ts';
import { buildInviteUrl, generateRoomCode } from '../network/roomCode.ts';
import { RoomError } from '../network/roomTransport.ts';
import {
  CREDENTIAL_ENDING_REASONS,
  sessionError,
  type ConnectionPhase,
  type SessionClosedReason,
  type SessionError,
  type SessionUpdate,
} from '../network/session.ts';
import { ACTION_LOCK_MS, LAST_CARD_GRACE_MS } from '../network/timing.ts';
import {
  applyLanguage,
  applyTheme,
  clearResumableRoom,
  loadDisplayName,
  loadLanguage,
  loadResumableRoom,
  loadSound,
  loadTheme,
  saveDisplayName,
  saveLanguage,
  saveResumableRoom,
  saveSound,
  saveTheme,
  type ResumableRoom,
  type ThemeChoice,
} from './persistence.ts';
import type { Beat } from './beat.ts';

const log = createLogger('store');

export type Screen = 'home' | 'create' | 'join' | 'lobby' | 'game' | 'over';

export interface FeedEntry {
  readonly id: number;
  readonly event: GameEvent;
}

export interface RejectionNotice {
  readonly code: RejectionCode;
  readonly nonce: number;
}

/** One line for assistive technology; the nonce forces a re-announcement. */
export interface Announcement {
  readonly text: string;
  readonly nonce: number;
}

/** Maximum entries kept in the game log; older lines are dropped. */
const FEED_LIMIT = 60;
const ROOM_CODE_ATTEMPTS = 4;

export interface AppState {
  language: Language;
  theme: ThemeChoice;
  /** Whether the table makes a sound. */
  sound: boolean;
  displayName: string;

  screen: Screen;

  /** Whether this device is in a room at all. Everybody at a table is a client. */
  inRoom: boolean;
  phase: ConnectionPhase;
  busy: boolean;
  roomCode: string | null;
  inviteUrl: string | null;
  localPlayerId: string | null;

  lobby: LobbySnapshot | null;
  publicState: PublicGameState | null;
  hand: readonly Card[];
  feed: readonly FeedEntry[];
  /**
   * The newest accepted command, for the presentation layer only.
   *
   * Nothing about the game depends on it: it carries no authority and no state
   * that is not already in `publicState`, `hand` and `feed`. It exists so that a
   * cue can be driven by "what just happened, from where, to where" without
   * having to reconstruct that from three separate writes.
   */
  beat: Beat | null;
  playAgain: { readonly agreed: readonly string[]; readonly required: number } | null;

  error: SessionError | null;
  rejection: RejectionNotice | null;
  closedReason: SessionClosedReason | null;
  resumable: ResumableRoom | null;
  /** Who asked the table to hold, or `null`. */
  pausedBy: string | null;
  /** Set when another player nudges you; the nonce forces a re-announcement. */
  nudge: { readonly fromPlayerId: string; readonly nonce: number } | null;
  /**
   * The most recent "last card" catch, for the banner every seat sees.
   *
   * The catch is in the log like everything else, but the log's visible line is
   * the newest one — and a catch is immediately followed by the draw it caused,
   * so the one line naming who called it was on screen for no time at all. With
   * three or more players that left the table knowing somebody had been caught
   * and not by whom. Held as state rather than derived from the feed so only a
   * catch that actually arrives raises it, never one replayed on reconnection.
   */
  caught: {
    readonly targetId: string;
    readonly byId: string;
    readonly penalty: number;
    readonly nonce: number;
  } | null;

  /**
   * The easements, as far as this client is told about them.
   *
   * `settings` is populated only on the creator's device, because the room only
   * sends it there — every other player's copy stays `null` for the life of the
   * room, and there is no derivation that would fill it in. `catchDelayMs` is how
   * long this player's own "never declared!" button waits, which is about them and
   * says nothing about anybody else. See `docs/assist.md`.
   */
  assist: {
    readonly catchDelayMs: number;
    readonly settings: AssistSettings | null;
  };

  /** True from the moment a move is submitted until the table answers. */
  actionPending: boolean;
  /** Set when the player asks to leave; the shell owns the confirmation. */
  leaveIntent: boolean;
  /** `navigator.onLine`, watched so the UI can explain a dead connection. */
  online: boolean;
  announcement: Announcement | null;
}

export interface AppActions {
  readonly setLanguage: (language: Language) => void;
  readonly setTheme: (theme: ThemeChoice) => void;
  readonly setSound: (on: boolean) => void;
  readonly setDisplayName: (name: string) => void;

  readonly goTo: (screen: Screen) => void;
  readonly dismissError: () => void;
  readonly dismissRejection: () => void;
  readonly dismissClosed: () => void;
  readonly forgetResumable: () => void;
  readonly dismissNudge: () => void;
  readonly dismissCaught: () => void;

  readonly createRoom: (options: {
    name: string;
    maxPlayers: number;
    tableLanguage: Language;
    gameMode: GameMode;
  }) => Promise<void>;
  readonly joinRoom: (options: {
    name: string;
    roomCode: string;
    resume?: { playerId: string; resumeToken: string };
  }) => Promise<void>;
  readonly retryConnection: () => void;

  readonly setMaxPlayers: (value: number) => void;
  /** Picks how the next round is won. Lobby only; the room refuses it after the deal. */
  readonly setGameMode: (mode: GameMode) => void;
  readonly removePlayer: (playerId: string) => void;
  readonly startGame: () => void;
  /** Seats a robot. Lobby only, and only for the seat holding the lobby buttons. */
  readonly addBot: () => void;
  /** Whether a robot may play a seat nobody is answering for. */
  readonly setStandInEnabled: (enabled: boolean) => void;
  /** Sets who the table quietly leans towards. Lobby only, and creator only. */
  readonly setAssist: (level: AssistLevel, playerIds: readonly string[]) => void;
  /** Puts a robot on somebody's seat now, rather than waiting. */
  readonly standInNow: (playerId: string) => void;
  /** Hands a seat back from the robot playing it. */
  readonly stopStandIn: (playerId: string) => void;
  /** Passes the turn of a player who is away. */
  readonly skipAbsentTurn: (playerId: string) => void;
  /** Takes an absent player out of the round, keeping their cards out of play. */
  readonly removeFromRound: (playerId: string) => void;
  /** Asks the table to hold, or lets it carry on. */
  readonly setPaused: (paused: boolean) => void;
  readonly voteAbandon: (agree: boolean) => void;
  readonly nudgePlayer: (playerId: string) => void;
  /**
   * Plays a card, naming a colour when the card asks for one.
   *
   * No shout travels with it. The room still accepts one — the wire keeps the
   * field, so a client from an older build is not broken by this — but nothing
   * here sends it: the declaration opens after the card has landed, alongside the
   * catch it exposes its owner to, and never before.
   */
  readonly playCard: (cardId: string, chosenColor?: 'red' | 'blue' | 'green' | 'yellow') => void;
  readonly drawCard: () => void;
  readonly closeTaki: () => void;
  readonly passBreak: () => void;
  readonly declareLastCard: () => void;
  readonly catchLastCard: (targetId: string) => void;
  readonly votePlayAgain: (agree: boolean) => void;
  readonly requestLeave: () => void;
  readonly cancelLeave: () => void;
  readonly leaveRoom: () => void;
  readonly setOnline: (online: boolean) => void;
  readonly announce: (text: string) => void;
}

export type AppStore = AppState & AppActions;

/**
 * The live session lives outside the store: it holds timers and a socket that must
 * never be treated as renderable state.
 */
let session: ClientSession | null = null;
/**
 * Which session the store is currently listening to.
 *
 * A session's observer is fixed when it is constructed, so a session that has been
 * superseded can still speak — and one of the things it says on the way out is
 * `closed`, which clears `session`. Stamping each observer with the epoch it belongs
 * to makes a superseded session's parting words inert.
 */
let sessionEpoch = 0;
let feedCounter = 0;
let rejectionCounter = 0;
let announcementCounter = 0;
let nudgeCounter = 0;
let caughtCounter = 0;
let beatCounter = 0;
/**
 * How long the table is held after somebody wins, before the standings.
 *
 * The payoff of a whole round used to be thrown away: the winning card was still
 * landing when the route changed under it.
 */
const WIN_HOLD_MS = 900;
/**
 * Identifies the hold currently in flight, so a stale one cannot fire.
 *
 * Deliberately not `sessionEpoch`. That counter answers "which session owns the
 * store", and it moves on create, join, resume and handover — not on leaving, and
 * not on a connection closing. Worse, a close keeps the screen for every reason
 * except a voluntary leave, precisely so the dialog explaining it can be drawn on
 * top. A hold guarded by the epoch would therefore have survived a disconnection
 * and routed the player to the standings of a round that was interrupted.
 */
let holdToken = 0;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
/** Version of the last published beat, so a replayed batch does not mint another. */
let lastBeatVersion = -1;
let actionLockTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The intent currently in flight.
 *
 * The lock is keyed on this rather than on the table moving, because in this game
 * other players legally act out of turn — so a new snapshot may have nothing to do
 * with my move, and treating it as proof of delivery is how a lost action comes to
 * look like a delivered one.
 */
let pendingRequestId: string | null = null;

/**
 * How sessions reach a room. Replaced by tests, which run a real room in-process
 * rather than a socket — see `tests/unit/helpers/room.ts`.
 */
let channelFactory: ChannelFactory | null = null;

/** Test seam: replaces the active session (used by component tests). */
export function __setSessionForTests(next: ClientSession | null): void {
  session = next;
}

/** Test seam: routes every new session to a room of the test's choosing. */
export function __setChannelFactoryForTests(next: ChannelFactory | null): void {
  channelFactory = next;
}

/** What every client believes before the room has told it anything. */
const NO_ASSIST_STATE = {
  catchDelayMs: LAST_CARD_GRACE_MS,
  settings: null,
} as const;

function initialState(): AppState {
  const language = loadLanguage();
  const theme = loadTheme();
  return {
    language,
    theme,
    sound: loadSound(),
    displayName: loadDisplayName(),
    screen: 'home',
    inRoom: false,
    phase: 'idle',
    busy: false,
    roomCode: null,
    inviteUrl: null,
    localPlayerId: null,
    lobby: null,
    publicState: null,
    hand: [],
    feed: [],
    beat: null,
    playAgain: null,
    error: null,
    rejection: null,
    closedReason: null,
    resumable: loadResumableRoom(),
    pausedBy: null,
    nudge: null,
    caught: null,
    assist: NO_ASSIST_STATE,
    actionPending: false,
    leaveIntent: false,
    online: typeof navigator === 'undefined' || navigator.onLine !== false,
    announcement: null,
  };
}

const CLEARED_SESSION: Partial<AppState> = {
  inRoom: false,
  phase: 'idle',
  busy: false,
  roomCode: null,
  inviteUrl: null,
  localPlayerId: null,
  lobby: null,
  publicState: null,
  hand: [],
  feed: [],
  beat: null,
  playAgain: null,
  actionPending: false,
  leaveIntent: false,
  pausedBy: null,
  caught: null,
  /*
   * Cleared with the session, and not merely tidiness: a creator's list belongs to
   * the room it was set in, and carrying one into the next room would show the next
   * table's host a list of children who are not at it.
   */
  assist: NO_ASSIST_STATE,
};

function screenForLobbyPhase(phase: LobbySnapshot['phase']): Screen {
  switch (phase) {
    case 'lobby':
      return 'lobby';
    case 'inGame':
      return 'game';
    case 'finished':
      return 'over';
  }
}

export const useAppStore = create<AppStore>((set, get) => {
  /** Releases the "move in flight" lock, whatever released it. */
  /**
   * Forgets what the table looked like a moment ago.
   *
   * Called at every boundary that already clears the feed — a new room, a resumed
   * one, a fresh round. Without it the first beat of a round would carry a `from`
   * belonging to the previous one, and its version check would compare against a
   * version that no longer means anything.
   */
  /**
   * Abandons a pending win hold.
   *
   * Called from every path that takes the player off the table for a reason other
   * than the round ending: leaving, a closed session, an error. The token is bumped
   * as well as the timer cleared, because a callback already queued by the platform
   * cannot be unqueued.
   */
  function clearHold(): void {
    holdToken += 1;
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function resetBeatTracking(): void {
    lastBeatVersion = -1;
  }

  function clearActionLock(): void {
    if (actionLockTimer !== null) {
      clearTimeout(actionLockTimer);
      actionLockTimer = null;
    }
    pendingRequestId = null;
    if (get().actionPending) {
      set({ actionPending: false });
    }
  }

  /**
   * Binds an observer to one session's lifetime.
   *
   * Updates from a session that is no longer the current one are dropped. Without
   * this, an abandoned connection attempt or a superseded session can still write
   * to the store — most damagingly by reporting its own closure.
   */
  function observerFor(epoch: number): (update: SessionUpdate) => void {
    return (update) => {
      if (epoch !== sessionEpoch) {
        return;
      }
      applyUpdate(update);
    };
  }

  /** Applies one session update to the store. */
  function applyUpdate(update: SessionUpdate): void {
    switch (update.type) {
      case 'phase':
        set({ phase: update.phase });
        return;
      case 'lobby': {
        const next = screenForLobbyPhase(update.lobby.phase);
        /*
         * The round is over and the table is still on screen: hold it for a beat so
         * the last card can land and the winner can be seen winning, then move.
         *
         * Only the screen is deferred. The lobby itself is applied at once, so the
         * standings have their data the moment they do render — and nothing on the
         * table reads `phase === 'finished'`, so holding the screen changes nothing
         * about what is being looked at meanwhile.
         */
        if (next === 'over' && get().screen === 'game') {
          set({ lobby: update.lobby });
          clearHold();
          const token = holdToken;
          holdTimer = setTimeout(() => {
            holdTimer = null;
            // Anything that took the player off the table in the meantime wins.
            if (token === holdToken && get().screen === 'game') {
              set({ screen: 'over' });
            }
          }, WIN_HOLD_MS);
          return;
        }
        clearHold();
        set({ lobby: update.lobby, screen: next });
        return;
      }
      case 'publicState':
        set({ publicState: update.state });
        return;
      case 'hand':
        set({ hand: update.cards });
        return;
      case 'events': {
        const entries = update.events.map((event) => {
          feedCounter += 1;
          return { id: feedCounter, event };
        });
        /*
         * A catch is raised out of the batch as its own notice. Only the last one
         * in a batch can be shown, and showing the last is right: two catches in
         * one batch means the older is already answered by the newer.
         */
        const lastCatch = [...update.events].reverse().find((event) => event.type === 'lastCardCaught');
        if (lastCatch !== undefined) {
          caughtCounter += 1;
        }
        /*
         * One beat per accepted command, identified by the version it produced.
         * The version is the right identity because one accepted command is one
         * bump, and the check has to live here: the client drops event batches
         * only when the version is strictly older, so a host replaying its log
         * after a reconnect sends an exact-version batch straight through — and
         * the update carries no version of its own to compare.
         */
        const current = get().publicState;
        const beat =
          current !== null && current.version !== lastBeatVersion
            ? ((): Beat => {
                lastBeatVersion = current.version;
                beatCounter += 1;
                return { seq: beatCounter, events: update.events };
              })()
            : null;
        set((state) => ({
          feed: [...state.feed, ...entries].slice(-FEED_LIMIT),
          ...(beat !== null ? { beat } : {}),
          ...(lastCatch !== undefined
            ? {
                caught: {
                  targetId: lastCatch.playerId,
                  byId: lastCatch.caughtById,
                  penalty: lastCatch.penalty,
                  nonce: caughtCounter,
                },
              }
            : {}),
        }));
        return;
      }
      case 'actionRejected':
        if (update.requestId === undefined || update.requestId === pendingRequestId) {
          clearActionLock();
        }
        rejectionCounter += 1;
        set({ rejection: { code: update.code, nonce: rejectionCounter } });
        return;
      case 'actionAccepted':
        if (update.requestId === pendingRequestId) {
          clearActionLock();
        }
        return;
      case 'error':
        clearHold();
        set({ error: update.error, busy: false });
        return;
      case 'paused':
        set({ pausedBy: update.pausedBy });
        return;
      case 'nudged':
        nudgeCounter += 1;
        set({ nudge: { fromPlayerId: update.fromPlayerId, nonce: nudgeCounter } });
        return;
      case 'assist':
        /*
         * `settings` is kept when a later message omits it rather than being cleared
         * by it. The room sends the list only to the seat holding the buttons, and
         * only that field is conditional — so an update with no list means "not for
         * you", which for the creator's own device never happens, and for anybody
         * else's leaves a `null` exactly as null.
         */
        set((state) => ({
          assist: {
            catchDelayMs: update.catchDelayMs,
            settings: update.settings ?? state.assist.settings,
          },
        }));
        return;
      case 'playAgain':
        set({ playAgain: { agreed: update.agreed, required: update.required } });
        return;
      case 'identity': {
        const roomCode = get().roomCode;
        set({ localPlayerId: update.playerId, displayName: update.displayName });
        saveDisplayName(update.displayName);
        if (roomCode) {
          /*
           * Saved for *every* seat now, the room's creator included. Their seat used
           * to be the one seat with no way back — it was the authority, and an
           * authority cannot rejoin itself — so instead of a credential they got a
           * copy of the whole game in `localStorage` and a button to restart it from.
           */
          saveResumableRoom({
            roomCode,
            playerId: update.playerId,
            resumeToken: update.resumeToken,
            displayName: update.displayName,
          });
          set({ resumable: loadResumableRoom() });
        }
        return;
      }
      case 'closed': {
        /*
         * A hold must not survive this. Every close reason except a voluntary
         * leave deliberately *keeps* the screen, so the dialog explaining it can be
         * drawn over the table — which means a pending hold would have fired
         * afterwards and routed the player to the standings of a round that was
         * interrupted.
         */
        clearHold();
        releaseSound();
        session = null;
        /*
         * Only an explicit departure or a removal means the seat is gone. This
         * used to clear the credential for every reason but one — including a host
         * that had merely blinked, and including the tab-took-over case — so the
         * one thing a player needed in order to come back was destroyed at exactly
         * the moment they needed it.
         */
        if (CREDENTIAL_ENDING_REASONS.has(update.reason)) {
          clearResumableRoom();
        }
        set({
          ...CLEARED_SESSION,
          closedReason: update.reason,
          resumable: loadResumableRoom(),
          /*
           * A voluntary ending explains itself, so no dialog is drawn for it. Every
           * other reason keeps the screen, because the dialog that explains it is drawn
           * on top and offers the way out.
           */
          ...(update.reason === 'leftVoluntarily' ? { screen: 'home' as const } : {}),
        });
        return;
      }
    }
  }

  /**
   * Sends one move and locks the table until the answer lands.
   *
   * The lock is what stops a double tap, an impatient second tap, or a stuck
   * finger from becoming two moves — the host would reject the duplicate, but
   * the player would see a confusing "that card is not in your hand" for a card
   * they legitimately played.
   */
  function submit(action: GameAction): void {
    if (!session || get().actionPending || get().pausedBy !== null) {
      return;
    }
    if (actionLockTimer !== null) {
      clearTimeout(actionLockTimer);
    }
    // A request id, minted once here, is what lets a re-send after a reconnect be
    // recognised as the same intent rather than applied a second time.
    const requestId = `rq-${String(Date.now())}-${String(rejectionCounter)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    pendingRequestId = requestId;
    actionLockTimer = setTimeout(clearActionLock, ACTION_LOCK_MS);
    set({ actionPending: true });
    session.submitAction(action, requestId);
  }

  /**
   * Asks the room for a lobby power.
   *
   * Every one of these used to be a direct method call on the local authority, which
   * is why the UI could simply check `role === 'host'` and call it. They are messages
   * now, and the room decides: it honours them only from the seat named by
   * `creatorPlayerId`. The UI still hides the buttons from everybody else, but that
   * is a courtesy rather than the enforcement.
   */
  function command(next: RoomCommand): void {
    session?.roomCommand(next);
  }

  return {
    ...initialState(),

    setLanguage: (language) => {
      saveLanguage(language);
      applyLanguage(language, directionFor(language));
      set({ language });
    },

    setTheme: (theme) => {
      saveTheme(theme);
      applyTheme(theme);
      set({ theme });
    },

    setSound: (on) => {
      saveSound(on);
      setSoundEnabled(on);
      set({ sound: on });
    },

    setDisplayName: (name) => {
      const cleaned = sanitizeDisplayName(name);
      set({ displayName: cleaned });
      saveDisplayName(cleaned);
    },

    goTo: (screen) => {
      set({ screen });
    },

    dismissError: () => {
      set({ error: null });
    },

    dismissRejection: () => {
      set({ rejection: null });
    },

    dismissClosed: () => {
      set({ closedReason: null, screen: 'home' });
    },

    forgetResumable: () => {
      clearResumableRoom();
      set({ resumable: null });
    },

    dismissNudge: () => {
      set({ nudge: null });
    },

    dismissCaught: () => {
      set({ caught: null });
    },

    createRoom: async ({ name, maxPlayers, tableLanguage, gameMode }) => {
      if (get().busy) {
        return;
      }
      /*
       * Woken here, inside the gesture, and never on the first card tap: `resume()` is
       * asynchronous, so a context woken by the tap that should have made a sound
       * swallows or delays its own first cue.
       */
      unlockSound();
      const cleaned = sanitizeDisplayName(name);
      resetBeatTracking();
      set({ busy: true, error: null, closedReason: null, feed: [], beat: null });
      saveDisplayName(cleaned);

      /*
       * Draw a code, and let the room tell us whether it is free.
       *
       * The collision check used to live in the relay's id table: the host claimed a
       * peer id derived from the code, and a second host was refused it. There is no
       * id to claim now, so the room answers instead — `roomTaken` means it already
       * has players in it, and we draw again. Same four attempts, same odds, one
       * fewer secret.
       */
      for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
        const roomCode = generateRoomCode();
        set({ inRoom: true, roomCode, phase: 'connecting' });
        sessionEpoch += 1;
        const attemptEpoch = sessionEpoch;
        const clientSession = new ClientSession({
          roomCode,
          displayName: cleaned,
          create: { maxPlayers, tableLanguage, gameMode },
          observer: observerFor(attemptEpoch),
          ...(channelFactory ? { connect: channelFactory } : {}),
        });
        session = clientSession;
        await clientSession.start();
        // The room's answer arrives on the wire, after the request has gone out.
        // Acting on `start()` alone is acting before it has said anything.
        await clientSession.awaitJoin();
        if (attemptEpoch !== sessionEpoch) {
          // The player walked away while we were connecting.
          return;
        }
        if (clientSession.rejection === 'roomTaken') {
          clientSession.destroy('leftVoluntarily');
          session = null;
          set({ error: null, closedReason: null });
          continue;
        }
        if (clientSession.connectionPhase === 'failed') {
          set({ busy: false });
          return;
        }
        set({
          busy: false,
          screen: 'lobby',
          inviteUrl: buildInviteUrl({ roomCode }, window.location.href),
        });
        return;
      }

      log.warn('could not find a free room code');
      set({ ...CLEARED_SESSION, error: sessionError('roomTaken'), phase: 'failed' });
    },

    joinRoom: async ({ name, roomCode, resume }) => {
      // Same reason as `createRoom`: inside the gesture, before any cue is due.
      unlockSound();
      if (get().busy) {
        return;
      }
      const cleaned = sanitizeDisplayName(name);
      resetBeatTracking();
      set({
        busy: true,
        error: null,
        closedReason: null,
        feed: [],
        beat: null,
        inRoom: true,
        roomCode,
        phase: 'connecting',
        screen: 'lobby',
      });
      saveDisplayName(cleaned);

      sessionEpoch += 1;
      const clientSession = new ClientSession({
        roomCode,
        displayName: cleaned,
        observer: observerFor(sessionEpoch),
        ...(resume ? { resume } : {}),
        ...(channelFactory ? { connect: channelFactory } : {}),
      });
      session = clientSession;
      try {
        await clientSession.start();
        await clientSession.awaitJoin();
        set({ busy: false, inviteUrl: buildInviteUrl({ roomCode }, window.location.href) });
      } catch (error) {
        log.warn('join failed', error);
        set({
          busy: false,
          phase: 'failed',
          error:
            error instanceof RoomError
              ? sessionError(error.code, error.message)
              : sessionError('unknown', error instanceof Error ? error.message : undefined),
        });
      }
    },

    retryConnection: () => {
      set({ error: null });
      session?.retry();
    },

    setMaxPlayers: (value) => {
      command({ type: 'setMaxPlayers', maxPlayers: Math.round(value) });
    },

    setGameMode: (mode) => {
      command({ type: 'setGameMode', mode });
    },

    removePlayer: (playerId) => {
      command({ type: 'kickPlayer', playerId });
    },

    startGame: () => {
      clearActionLock();
      resetBeatTracking();
      set({ feed: [], beat: null, caught: null });
      command({ type: 'startGame' });
    },

    addBot: () => {
      command({ type: 'addBot' });
    },

    setStandInEnabled: (enabled) => {
      command({ type: 'setStandInEnabled', enabled });
    },

    setAssist: (level, playerIds) => {
      /*
       * Sent, and then waited for. The room decides what the list actually becomes —
       * it drops the creator's own seat, ignores robots, and refuses a list that
       * covers the whole table — so echoing the request into the store locally would
       * show a host their own request rather than the setting. `assistState` comes
       * back either way.
       */
      command({ type: 'setAssist', level, playerIds: [...playerIds] });
    },

    standInNow: (playerId) => {
      command({ type: 'standInNow', playerId });
    },

    stopStandIn: (playerId) => {
      command({ type: 'stopStandIn', playerId });
    },

    skipAbsentTurn: (playerId) => {
      command({ type: 'skipAbsentTurn', playerId });
    },

    removeFromRound: (playerId) => {
      command({ type: 'removeFromRound', playerId });
    },

    setPaused: (paused) => {
      session?.requestPause(paused);
    },

    voteAbandon: (agree) => {
      session?.voteAbandon(agree);
    },

    nudgePlayer: (playerId) => {
      session?.nudge(playerId);
    },

    playCard: (cardId, chosenColor) => {
      submit({ type: 'playCard', cardId, ...(chosenColor ? { chosenColor } : {}) });
    },

    drawCard: () => {
      submit({ type: 'drawCard' });
    },

    closeTaki: () => {
      submit({ type: 'closeTaki' });
    },

    passBreak: () => {
      submit({ type: 'passBreak' });
    },

    declareLastCard: () => {
      submit({ type: 'declareLastCard' });
    },

    catchLastCard: (targetId) => {
      submit({ type: 'catchLastCard', targetId });
    },

    votePlayAgain: (agree) => {
      session?.votePlayAgain(agree);
    },

    requestLeave: () => {
      set({ leaveIntent: true });
    },

    cancelLeave: () => {
      set({ leaveIntent: false });
    },

    leaveRoom: () => {
      clearHold();
      // The audio device goes back when the table does; holding one open for the
      // life of the tab is a real cost on a phone and buys nothing.
      releaseSound();
      session?.destroy('leftVoluntarily');
      session = null;
      clearResumableRoom();
      clearActionLock();
      set({
        ...CLEARED_SESSION,
        screen: 'home',
        error: null,
        closedReason: null,
        resumable: null,
        nudge: null,
      });
    },

    setOnline: (online) => {
      if (get().online !== online) {
        set({ online });
      }
    },

    announce: (text) => {
      if (text.length === 0) {
        return;
      }
      announcementCounter += 1;
      set({ announcement: { text, nonce: announcementCounter } });
    },
  };
});

/** Applies persisted preferences to the document. Call once at start-up. */
export function initialiseAppearance(): void {
  const { language, theme } = useAppStore.getState();
  applyLanguage(language ?? DEFAULT_LANGUAGE, directionFor(language));
  applyTheme(theme);
}
