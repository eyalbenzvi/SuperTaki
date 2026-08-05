import { create } from 'zustand';
import { DEFAULT_LANGUAGE, directionFor, type Language } from '../../../i18n/index.ts';
import { record } from '../../../lib/diagnostics.ts';
import { onSleep } from '../../../lib/lifecycle.ts';
import { createRoomClaim } from '../../../lib/id.ts';
import { releaseSound, setSoundEnabled, unlockSound } from '../../../lib/audio.ts';
import { createLogger } from '../../../lib/logger.ts';
import { sanitizeDisplayName } from '../../../lib/sanitize.ts';
import type { Card } from '../engine/cards.ts';
import type { GameEvent, RejectionCode } from '../engine/state.ts';
import type { PublicGameState } from '../engine/views.ts';
import { ClientSession } from '../network/clientSession.ts';
import { HostSession, createHostSession, type HostRestoreState } from '../network/hostSession.ts';
import type { GameAction, LobbySnapshot } from '../network/protocol.ts';
import { buildInviteUrl, generateRoomCode, hostPeerIdForRoom } from '../network/roomCode.ts';
import {
  CREDENTIAL_ENDING_REASONS,
  sessionError,
  type ConnectionPhase,
  type SessionClosedReason,
  type SessionError,
  type SessionUpdate,
} from '../network/session.ts';
import { ACTION_LOCK_MS, HOST_ID_RETRY_SCHEDULE_MS } from '../network/timing.ts';
import { TransportError, type Transport } from '../network/transport.ts';
import { createTransport } from '../network/transportFactory.ts';
import {
  clearHostedRoom,
  flushHostedRoom,
  loadHostedRoom,
  saveHostedRoom,
  validateHandoffSnapshot,
  type HostedRoom,
} from './hostSnapshot.ts';
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

/**
 * How many times a returning host tries to reclaim its own room code.
 *
 * The schedule spans seventy-five seconds because the broker holds a dropped peer
 * id for up to a minute: the id being refused is usually our own ghost, so giving
 * up early means conceding the room code — and invalidating every invite already
 * sent — at the moment it was still recoverable.
 */
const HOST_ID_ATTEMPTS = HOST_ID_RETRY_SCHEDULE_MS.length;

export interface AppState {
  language: Language;
  theme: ThemeChoice;
  /** Whether the table makes a sound. */
  sound: boolean;
  displayName: string;

  screen: Screen;

  role: 'host' | 'client' | null;
  phase: ConnectionPhase;
  busy: boolean;
  roomCode: string | null;
  hostPeerId: string | null;
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
  /** A room this device was hosting and can take back. */
  hostable: HostedRoom | null;
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
  readonly forgetHostable: () => void;
  readonly dismissNudge: () => void;
  readonly dismissCaught: () => void;

  readonly createRoom: (options: {
    name: string;
    maxPlayers: number;
    tableLanguage: Language;
  }) => Promise<void>;
  readonly joinRoom: (options: {
    name: string;
    roomCode: string;
    hostPeerId?: string;
    resume?: { playerId: string; resumeToken: string };
  }) => Promise<void>;
  readonly retryConnection: () => void;
  /** Takes back a room this device was hosting, on the same room code. */
  readonly resumeHosting: () => Promise<void>;

  readonly setMaxPlayers: (value: number) => void;
  readonly removePlayer: (playerId: string) => void;
  readonly startGame: () => void;
  /** Passes the turn of a player who is away. Host only. */
  readonly skipAbsentTurn: (playerId: string) => void;
  /** Takes an absent player out of the round, keeping their cards out of play. */
  readonly removeFromRound: (playerId: string) => void;
  /** Asks the table to hold, or lets it carry on. */
  readonly setPaused: (paused: boolean) => void;
  readonly voteAbandon: (agree: boolean) => void;
  readonly nudgePlayer: (playerId: string) => void;
  /** Offers the room to another player and leaves. Host only. */
  readonly handOver: (playerId: string) => void;
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
 * The live session lives outside the store: it holds timers and transport
 * handles that must never be treated as renderable state.
 */
let session: HostSession | ClientSession | null = null;
/**
 * Relay claim for the room this device is hosting. Minted when the room is
 * created, persisted in the host snapshot, and presented again on reclaim — it
 * is what proves to the relay that this device owns the room code.
 */
let activeRoomClaim: string | null = null;
/**
 * Which session the store is currently listening to.
 *
 * A session's observer is fixed when it is constructed, so a session that has
 * been superseded can still speak — and one of the things it says on the way out
 * is `closed`, which clears `session`. During a handover that is actively
 * harmful: this device creates its new host session, then tears down the client
 * session it used to be, and the teardown's `closed` would null out the host that
 * had just been installed. Stamping each observer with the epoch it belongs to
 * makes a superseded session's parting words inert.
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
let detachSleepHook: (() => void) | null = null;

/** Test seam: replaces the active session (used by component tests). */
export function __setSessionForTests(next: HostSession | ClientSession | null): void {
  session = next;
}

function initialState(): AppState {
  const language = loadLanguage();
  const theme = loadTheme();
  return {
    language,
    theme,
    sound: loadSound(),
    displayName: loadDisplayName(),
    screen: 'home',
    role: null,
    phase: 'idle',
    busy: false,
    roomCode: null,
    hostPeerId: null,
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
    hostable: loadHostedRoom(),
    pausedBy: null,
    nudge: null,
    caught: null,
    actionPending: false,
    leaveIntent: false,
    online: typeof navigator === 'undefined' || navigator.onLine !== false,
    announcement: null,
  };
}

const CLEARED_SESSION: Partial<AppState> = {
  role: null,
  phase: 'idle',
  busy: false,
  roomCode: null,
  hostPeerId: null,
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
   * Becomes the host, on the room the previous one just handed over.
   *
   * The order matters: this device starts serving on the next generation *before*
   * telling the old host it accepted. Only then does the old host step down and
   * point everybody here, so the table never has a moment with nowhere to go. If
   * anything fails, nothing is accepted and the old host simply carries on.
   */
  async function acceptHandoff(generation: number, snapshot: unknown, accept: () => void): Promise<void> {
    const roomCode = get().roomCode;
    if (!roomCode) {
      return;
    }
    const restore = validateHandoffSnapshot(snapshot);
    if (!restore) {
      log.warn('refusing a handover whose state did not parse');
      record('handover', 'refused: unreadable state');
      return;
    }
    const peerId = hostPeerIdForRoom(roomCode, generation);
    let transport: Transport | null = null;
    try {
      // A fresh claim: the successor owns a new generation id, not the old one.
      const claim = createRoomClaim();
      transport = createTransport({ id: peerId, claim });
      activeRoomClaim = claim;
      const previous = session;
      sessionEpoch += 1;
      const hostSession = await createHostSession({
        transport,
        roomCode,
        hostDisplayName: get().displayName || 'Host',
        maxPlayers: restore.maxPlayers,
        tableLanguage: restore.tableLanguage,
        observer: observerFor(sessionEpoch),
        restore,
        onSnapshot: persistHostedRoom,
        generation,
      });
      session = hostSession;
      attachSleepHook();
      accept();
      // The old client session has served its purpose; its transport must go, or
      // this device holds two peers and answers to both.
      if (previous instanceof ClientSession) {
        queueMicrotask(() => {
          previous.destroy('leftVoluntarily');
        });
      }
      set({
        role: 'host',
        hostPeerId: peerId,
        busy: false,
        inviteUrl: buildInviteUrl({ roomCode, hostPeerId: peerId }, window.location.href),
      });
      record('handover', 'took over the room', { generation });
    } catch (error) {
      log.warn('could not take the room over', error);
      record('handover', 'refused: could not claim the id', { generation });
      transport?.destroy();
    }
  }

  /** Persists the room whenever the host's authoritative state changes. */
  function persistHostedRoom(restore: HostRestoreState): void {
    const active = session;
    if (!(active instanceof HostSession)) {
      return;
    }
    saveHostedRoom({
      roomCode: active.roomCode,
      hostPeerId: active.hostPeerId,
      claim: activeRoomClaim,
      generation: active.generation,
      restore,
    });
    // Only touch the store when the *existence* of a recoverable room changes.
    // Re-publishing an equivalent object on every accepted move would churn every
    // subscriber for nothing.
    if (get().hostable === null) {
      const hostable = loadHostedRoom();
      if (hostable) {
        set({ hostable });
      }
    }
  }

  /**
   * Tells the table this device is reloading, and writes the room down first.
   *
   * `pagehide` is the only hook that fires reliably on a phone, and this single
   * message is what turns an ambiguous silence into "the host is coming back" —
   * which is the difference between a held seat and a lost game.
   */
  function attachSleepHook(): void {
    detachSleepHook?.();
    detachSleepHook = onSleep((reason) => {
      if (reason !== 'pagehide') {
        return;
      }
      const active = session;
      if (!(active instanceof HostSession)) {
        return;
      }
      flushHostedRoom({
        roomCode: active.roomCode,
        hostPeerId: active.hostPeerId,
        claim: activeRoomClaim,
        generation: active.generation,
        restore: active.snapshot(),
      });
      active.announceRestarting();
    });
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
      case 'handover':
        // The client session already re-points itself at the new host; the store
        // only needs to remember where the room went, so a later resume follows it.
        set((state) =>
          state.resumable ? { resumable: { ...state.resumable, generation: update.generation } } : {},
        );
        return;
      case 'handoffOffer':
        void acceptHandoff(update.generation, update.snapshot, update.accept);
        return;
      case 'playAgain':
        set({ playAgain: { agreed: update.agreed, required: update.required } });
        return;
      case 'identity': {
        const state = get();
        set({ localPlayerId: update.playerId, displayName: update.displayName });
        saveDisplayName(update.displayName);
        if (state.role === 'client' && state.roomCode && state.hostPeerId) {
          const room = {
            roomCode: state.roomCode,
            hostPeerId: state.hostPeerId,
            playerId: update.playerId,
            resumeToken: update.resumeToken,
            displayName: update.displayName,
            ...(state.resumable?.generation !== undefined ? { generation: state.resumable.generation } : {}),
          };
          saveResumableRoom(room);
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
        detachSleepHook?.();
        detachSleepHook = null;
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
        if (get().role === 'host') {
          clearHostedRoom();
          activeRoomClaim = null;
        }
        set({
          ...CLEARED_SESSION,
          closedReason: update.reason,
          resumable: loadResumableRoom(),
          hostable: loadHostedRoom(),
          /*
           * A voluntary ending explains itself, so no dialog is drawn for it — which
           * left a host who had just handed the room over sitting on a lobby screen
           * with no lobby behind it and nothing to press. Every other reason keeps the
           * screen, because the dialog that explains it is drawn on top and offers the
           * way out.
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

    if (session instanceof HostSession) {
      session.submitLocalAction(action);
      // The host answers itself synchronously, so nothing is left in flight.
      clearActionLock();
    } else {
      session.submitAction(action, requestId);
    }
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

    forgetHostable: () => {
      clearHostedRoom();
      activeRoomClaim = null;
      set({ hostable: null });
    },

    dismissNudge: () => {
      set({ nudge: null });
    },

    dismissCaught: () => {
      set({ caught: null });
    },

    createRoom: async ({ name, maxPlayers, tableLanguage }) => {
      if (get().busy) {
        return;
      }
      /*
       * Woken here, inside the gesture, and never on the first card tap: `resume()`
       * is asynchronous, so a context woken by the tap that should have made a
       * sound swallows or delays its own first cue.
       */
      unlockSound();
      const cleaned = sanitizeDisplayName(name);
      resetBeatTracking();
      set({ busy: true, error: null, closedReason: null, feed: [], beat: null });
      saveDisplayName(cleaned);

      for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
        const roomCode = generateRoomCode();
        const peerId = hostPeerIdForRoom(roomCode);
        const claim = createRoomClaim();
        // Held outside the try so a failed attempt can tear its transport down
        // instead of leaving an orphaned socket that may still fire `open`.
        let transport: Transport | null = null;
        try {
          transport = createTransport({ id: peerId, claim });
          activeRoomClaim = claim;
          set({ role: 'host', roomCode, hostPeerId: peerId, phase: 'initializing' });
          sessionEpoch += 1;
          const hostSession = await createHostSession({
            transport,
            roomCode,
            hostDisplayName: cleaned,
            maxPlayers,
            tableLanguage,
            observer: observerFor(sessionEpoch),
            onSnapshot: persistHostedRoom,
          });
          session = hostSession;
          attachSleepHook();
          set({
            busy: false,
            screen: 'lobby',
            inviteUrl: buildInviteUrl({ roomCode, hostPeerId: hostSession.hostPeerId }, window.location.href),
          });
          return;
        } catch (error) {
          const isTaken = error instanceof TransportError && error.code === 'idUnavailable';
          log.warn('room creation failed', error);
          transport?.destroy();
          if (!isTaken || attempt === ROOM_CODE_ATTEMPTS - 1) {
            set({
              ...CLEARED_SESSION,
              error:
                error instanceof TransportError
                  ? sessionError(error.code, error.message)
                  : sessionError('unknown', error instanceof Error ? error.message : undefined),
              phase: 'failed',
            });
            return;
          }
        }
      }
    },

    /**
     * Takes back a room this device was hosting, on the *same* room code.
     *
     * Keeping the code is the whole point: every invite already sent stays valid,
     * and every client's stored credential still fits, so the players reconnect on
     * their own without being told anything. It has to be patient, though — the
     * broker holds a dropped peer id for up to a minute, so the id we are trying to
     * reclaim is very often our own ghost. Giving up early would concede the code
     * and silently invalidate all those invites at the exact moment they were
     * recoverable.
     */
    resumeHosting: async () => {
      const hostable = get().hostable;
      if (!hostable || get().busy) {
        return;
      }
      resetBeatTracking();
      set({
        busy: true,
        error: null,
        closedReason: null,
        feed: [],
        beat: null,
        role: 'host',
        roomCode: hostable.roomCode,
        hostPeerId: hostable.hostPeerId,
        phase: 'initializing',
      });
      record('hostRestart', 'reclaiming room code', { room: hostable.roomCode });
      /*
       * The loop below can run for over a minute, and the player may leave in the
       * middle of it. Without this, a retry that finally succeeded would install a
       * session and republish a room they had deliberately walked away from.
       */
      sessionEpoch += 1;
      const attemptEpoch = sessionEpoch;

      for (let attempt = 0; attempt < HOST_ID_ATTEMPTS; attempt += 1) {
        if (attemptEpoch !== sessionEpoch || get().hostable === null) {
          record('hostRestart', 'abandoned: the room was let go');
          // Cleared rather than merely returned from: leaving `busy` set left the
          // player watching a spinner for a room nobody was going to reclaim.
          set({ ...CLEARED_SESSION, screen: 'home' });
          return;
        }
        if (attempt > 0) {
          const previous = HOST_ID_RETRY_SCHEDULE_MS[attempt - 1] ?? 0;
          const target = HOST_ID_RETRY_SCHEDULE_MS[attempt] ?? previous;
          await new Promise((resolve) => setTimeout(resolve, Math.max(target - previous, 0)));
        }
        let transport: Transport | null = null;
        try {
          /*
           * The stored claim is the room key: presenting it makes the relay hand
           * the id straight back, however long this device was gone. A snapshot
           * from before claims existed falls back to a fresh one, which succeeds
           * once the relay's hold on the old id expires.
           */
          const claim = hostable.claim ?? createRoomClaim();
          transport = createTransport({ id: hostable.hostPeerId, claim });
          activeRoomClaim = claim;
          const hostSession = await createHostSession({
            transport,
            roomCode: hostable.roomCode,
            hostDisplayName: get().displayName || 'Host',
            maxPlayers: hostable.restore.maxPlayers,
            tableLanguage: hostable.restore.tableLanguage,
            observer: observerFor(attemptEpoch),
            restore: hostable.restore,
            onSnapshot: persistHostedRoom,
            generation: hostable.generation,
          });
          /*
           * Checked again on the way out, not only on the way in. The attempt that
           * is in flight is the one most likely to succeed, so a player who gives up
           * while it is pending — the card offering this also offers "forget it" —
           * would otherwise have the room reinstated under them a moment later, and
           * republished to everybody holding an invitation.
           */
          if (attemptEpoch !== sessionEpoch || get().hostable === null) {
            record('hostRestart', 'abandoned: the room was let go');
            hostSession.destroy('leftVoluntarily');
            if (attemptEpoch === sessionEpoch) {
              // Only this attempt's own state is cleared. A newer epoch means some
              // other session owns the store now, and stamping over it would take a
              // room the player is actually in away from them.
              set({ ...CLEARED_SESSION, screen: 'home' });
            }
            return;
          }
          session = hostSession;
          attachSleepHook();
          set({
            busy: false,
            inviteUrl: buildInviteUrl(
              { roomCode: hostable.roomCode, hostPeerId: hostSession.hostPeerId },
              window.location.href,
            ),
          });
          record('hostRestart', 'room reclaimed', { attempt });
          return;
        } catch (error) {
          transport?.destroy();
          const isTaken = error instanceof TransportError && error.code === 'idUnavailable';
          log.warn('reclaiming the room failed', attempt, error);
          if (!isTaken) {
            set({
              ...CLEARED_SESSION,
              error:
                error instanceof TransportError
                  ? sessionError(error.code, error.message)
                  : sessionError('unknown', error instanceof Error ? error.message : undefined),
              phase: 'failed',
            });
            return;
          }
        }
      }
      record('hostRestart', 'could not reclaim the room code');
      set({
        ...CLEARED_SESSION,
        error: sessionError('idUnavailable'),
        phase: 'failed',
      });
    },

    joinRoom: async ({ name, roomCode, hostPeerId, resume }) => {
      // Same reason as `createRoom`: inside the gesture, before any cue is due.
      unlockSound();
      if (get().busy) {
        return;
      }
      const cleaned = sanitizeDisplayName(name);
      const targetHost = hostPeerId ?? hostPeerIdForRoom(roomCode);
      resetBeatTracking();
      set({
        busy: true,
        error: null,
        closedReason: null,
        feed: [],
        beat: null,
        role: 'client',
        roomCode,
        hostPeerId: targetHost,
        phase: 'initializing',
        screen: 'lobby',
      });
      saveDisplayName(cleaned);

      let transport: Transport | null = null;
      try {
        transport = createTransport({});
        sessionEpoch += 1;
        const clientSession = new ClientSession({
          transport,
          roomCode,
          hostPeerId: targetHost,
          displayName: cleaned,
          observer: observerFor(sessionEpoch),
          ...(resume ? { resume } : {}),
        });
        session = clientSession;
        await clientSession.start();
        set({ busy: false });
      } catch (error) {
        log.warn('join failed', error);
        transport?.destroy();
        set({
          busy: false,
          phase: 'failed',
          error:
            error instanceof TransportError
              ? sessionError(error.code, error.message)
              : sessionError('unknown', error instanceof Error ? error.message : undefined),
        });
      }
    },

    retryConnection: () => {
      const active = session;
      set({ error: null });
      if (active instanceof ClientSession) {
        active.retry();
      }
    },

    setMaxPlayers: (value) => {
      if (session instanceof HostSession) {
        session.setMaxPlayers(value);
      }
    },

    removePlayer: (playerId) => {
      if (session instanceof HostSession) {
        session.removePlayer(playerId);
      }
    },

    startGame: () => {
      if (session instanceof HostSession) {
        clearActionLock();
        resetBeatTracking();
        set({ feed: [], beat: null, caught: null });
        session.startGame();
      }
    },

    skipAbsentTurn: (playerId) => {
      if (session instanceof HostSession) {
        session.skipAbsentTurn(playerId);
      }
    },

    removeFromRound: (playerId) => {
      if (session instanceof HostSession) {
        session.removeFromRound(playerId);
      }
    },

    setPaused: (paused) => {
      const active = session;
      if (active instanceof HostSession) {
        active.setPaused(paused ? active.localPlayerId : null);
      } else if (active instanceof ClientSession) {
        active.requestPause(paused);
      }
    },

    voteAbandon: (agree) => {
      const active = session;
      if (active instanceof HostSession) {
        active.voteAbandon(agree);
      } else if (active instanceof ClientSession) {
        active.voteAbandon(agree);
      }
    },

    nudgePlayer: (playerId) => {
      const active = session;
      if (active instanceof HostSession) {
        active.nudge(playerId);
      } else if (active instanceof ClientSession) {
        active.nudge(playerId);
      }
    },

    handOver: (playerId) => {
      if (session instanceof HostSession) {
        // A living host, vouching on a channel both sides already trust. That is
        // what makes this safe without any of the verification an automatic
        // takeover from a silent host would need — and could not get.
        session.offerHandoff(playerId);
      }
    },

    playCard: (cardId, chosenColor) => {
      submit(chosenColor ? { type: 'playCard', cardId, chosenColor } : { type: 'playCard', cardId });
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
      if (session instanceof HostSession) {
        session.votePlayAgain(agree);
      } else if (session instanceof ClientSession) {
        session.votePlayAgain(agree);
      }
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
      detachSleepHook?.();
      detachSleepHook = null;
      clearResumableRoom();
      clearHostedRoom();
      activeRoomClaim = null;
      clearActionLock();
      set({
        ...CLEARED_SESSION,
        screen: 'home',
        error: null,
        closedReason: null,
        resumable: null,
        hostable: null,
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
