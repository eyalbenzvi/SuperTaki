import { create } from 'zustand';
import { DEFAULT_LANGUAGE, directionFor, type Language } from '../../../i18n/index.ts';
import { createLogger } from '../../../lib/logger.ts';
import { sanitizeDisplayName } from '../../../lib/sanitize.ts';
import type { Card } from '../engine/cards.ts';
import type { GameEvent, RejectionCode } from '../engine/state.ts';
import type { PublicGameState } from '../engine/views.ts';
import { ClientSession } from '../network/clientSession.ts';
import { HostSession, createHostSession } from '../network/hostSession.ts';
import type { GameAction, LobbySnapshot } from '../network/protocol.ts';
import { buildInviteUrl, generateRoomCode, hostPeerIdForRoom } from '../network/roomCode.ts';
import {
  sessionError,
  type ConnectionPhase,
  type SessionClosedReason,
  type SessionError,
  type SessionUpdate,
} from '../network/session.ts';
import { TransportError, type Transport } from '../network/transport.ts';
import { createTransport } from '../network/transportFactory.ts';
import {
  applyLanguage,
  applyTheme,
  clearResumableRoom,
  loadDisplayName,
  loadLanguage,
  loadResumableRoom,
  loadTheme,
  saveDisplayName,
  saveLanguage,
  saveResumableRoom,
  saveTheme,
  type ResumableRoom,
  type ThemeChoice,
} from './persistence.ts';

const log = createLogger('store');

export type Screen = 'home' | 'create' | 'join' | 'lobby' | 'game' | 'over' | 'rules';

export interface FeedEntry {
  readonly id: number;
  readonly event: GameEvent;
}

export interface RejectionNotice {
  readonly code: RejectionCode;
  readonly nonce: number;
}

/** Maximum entries kept in the game log; older lines are dropped. */
const FEED_LIMIT = 60;
const ROOM_CODE_ATTEMPTS = 4;

export interface AppState {
  language: Language;
  theme: ThemeChoice;
  displayName: string;

  screen: Screen;
  screenBeforeRules: Screen;

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
  playAgain: { readonly agreed: readonly string[]; readonly required: number } | null;

  error: SessionError | null;
  rejection: RejectionNotice | null;
  closedReason: SessionClosedReason | null;
  resumable: ResumableRoom | null;
}

export interface AppActions {
  readonly setLanguage: (language: Language) => void;
  readonly setTheme: (theme: ThemeChoice) => void;
  readonly setDisplayName: (name: string) => void;

  readonly goTo: (screen: Screen) => void;
  readonly openRules: () => void;
  readonly closeRules: () => void;
  readonly dismissError: () => void;
  readonly dismissRejection: () => void;
  readonly dismissClosed: () => void;
  readonly forgetResumable: () => void;

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

  readonly setMaxPlayers: (value: number) => void;
  readonly removePlayer: (playerId: string) => void;
  readonly startGame: () => void;
  readonly playCard: (cardId: string, chosenColor?: 'red' | 'blue' | 'green' | 'yellow') => void;
  readonly drawCard: () => void;
  readonly closeTaki: () => void;
  readonly votePlayAgain: (agree: boolean) => void;
  readonly leaveRoom: () => void;
}

export type AppStore = AppState & AppActions;

/**
 * The live session lives outside the store: it holds timers and transport
 * handles that must never be treated as renderable state.
 */
let session: HostSession | ClientSession | null = null;
let feedCounter = 0;
let rejectionCounter = 0;

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
    displayName: loadDisplayName(),
    screen: 'home',
    screenBeforeRules: 'home',
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
    playAgain: null,
    error: null,
    rejection: null,
    closedReason: null,
    resumable: loadResumableRoom(),
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
  playAgain: null,
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
  /** Applies one session update to the store. */
  function applyUpdate(update: SessionUpdate): void {
    switch (update.type) {
      case 'phase':
        set({ phase: update.phase });
        return;
      case 'lobby': {
        const current = get();
        const nextScreen = screenForLobbyPhase(update.lobby.phase);
        set({
          lobby: update.lobby,
          // Never navigate away from the rules page behind the player's back.
          screen: current.screen === 'rules' ? current.screen : nextScreen,
          screenBeforeRules: current.screen === 'rules' ? nextScreen : current.screenBeforeRules,
        });
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
        set((state) => ({ feed: [...state.feed, ...entries].slice(-FEED_LIMIT) }));
        return;
      }
      case 'actionRejected':
        rejectionCounter += 1;
        set({ rejection: { code: update.code, nonce: rejectionCounter } });
        return;
      case 'error':
        set({ error: update.error, busy: false });
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
          };
          saveResumableRoom(room);
          set({ resumable: loadResumableRoom() });
        }
        return;
      }
      case 'closed': {
        session = null;
        if (update.reason !== 'transportFailed') {
          clearResumableRoom();
        }
        set({
          ...CLEARED_SESSION,
          closedReason: update.reason,
          resumable: loadResumableRoom(),
        });
        return;
      }
    }
  }

  function submit(action: GameAction): void {
    if (!session) {
      return;
    }
    if (session instanceof HostSession) {
      session.submitLocalAction(action);
    } else {
      session.submitAction(action);
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

    setDisplayName: (name) => {
      const cleaned = sanitizeDisplayName(name);
      set({ displayName: cleaned });
      saveDisplayName(cleaned);
    },

    goTo: (screen) => {
      set({ screen });
    },

    openRules: () => {
      const current = get().screen;
      set({ screen: 'rules', screenBeforeRules: current === 'rules' ? get().screenBeforeRules : current });
    },

    closeRules: () => {
      set({ screen: get().screenBeforeRules });
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

    createRoom: async ({ name, maxPlayers, tableLanguage }) => {
      if (get().busy) {
        return;
      }
      const cleaned = sanitizeDisplayName(name);
      set({ busy: true, error: null, closedReason: null, feed: [] });
      saveDisplayName(cleaned);

      for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
        const roomCode = generateRoomCode();
        const peerId = hostPeerIdForRoom(roomCode);
        // Held outside the try so a failed attempt can tear its transport down
        // instead of leaving an orphaned socket that may still fire `open`.
        let transport: Transport | null = null;
        try {
          transport = createTransport({ id: peerId });
          set({ role: 'host', roomCode, hostPeerId: peerId, phase: 'initializing' });
          const hostSession = await createHostSession({
            transport,
            roomCode,
            hostDisplayName: cleaned,
            maxPlayers,
            tableLanguage,
            observer: applyUpdate,
          });
          session = hostSession;
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

    joinRoom: async ({ name, roomCode, hostPeerId, resume }) => {
      if (get().busy) {
        return;
      }
      const cleaned = sanitizeDisplayName(name);
      const targetHost = hostPeerId ?? hostPeerIdForRoom(roomCode);
      set({
        busy: true,
        error: null,
        closedReason: null,
        feed: [],
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
        const clientSession = new ClientSession({
          transport,
          roomCode,
          hostPeerId: targetHost,
          displayName: cleaned,
          observer: applyUpdate,
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
        set({ feed: [] });
        session.startGame();
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

    votePlayAgain: (agree) => {
      if (session instanceof HostSession) {
        session.votePlayAgain(agree);
      } else if (session instanceof ClientSession) {
        session.votePlayAgain(agree);
      }
    },

    leaveRoom: () => {
      session?.destroy('leftVoluntarily');
      session = null;
      clearResumableRoom();
      set({ ...CLEARED_SESSION, screen: 'home', error: null, closedReason: null, resumable: null });
    },
  };
});

/** Applies persisted preferences to the document. Call once at start-up. */
export function initialiseAppearance(): void {
  const { language, theme } = useAppStore.getState();
  applyLanguage(language ?? DEFAULT_LANGUAGE, directionFor(language));
  applyTheme(theme);
}
