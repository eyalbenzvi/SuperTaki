import type { Card } from '../engine/cards.ts';
import type { GameEvent, RejectionCode } from '../engine/state.ts';
import type { PublicGameState } from '../engine/views.ts';
import type { JoinRejectionReason, LobbySnapshot } from './protocol.ts';
import type { RoomErrorCode } from './roomTransport.ts';

/**
 * Connection lifecycle, surfaced verbatim in the UI.
 *
 * Exported as a value as well as a type so the dictionaries can be checked against
 * it rather than against a hand-kept copy of it — which is how `initializing` and
 * `ready` outlived the session that used to emit them.
 */
export const CONNECTION_PHASES = [
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'disconnected',
  'failed',
] as const;

export type ConnectionPhase = (typeof CONNECTION_PHASES)[number];

export type SessionErrorCode = RoomErrorCode | JoinRejectionReason | 'protocolMismatch';

export interface SessionError {
  readonly code: SessionErrorCode;
  /** Technical detail for the debug log; never shown untranslated to players. */
  readonly detail?: string;
  /** Whether the UI should offer a retry button. */
  readonly retryable: boolean;
}

/**
 * Why a session ended.
 *
 * A value as well as a type, so the dictionaries are checked against this list rather
 * than a hand-kept copy of it.
 *
 * Every one of these is terminal, which is new. There used to be reasons that were
 * not — a host reloading, a host handing the room to somebody else — and a great
 * deal of machinery existed so a client could tell those from a goodbye and hold its
 * seat through them. A room does not reload and does not move, so if the session is
 * over it is over, and what a client does about it is always the same.
 */
export const SESSION_CLOSED_REASONS = [
  'roomClosed',
  'removedByCreator',
  'duplicateConnection',
  'leftVoluntarily',
  /** The round ran out of players. */
  'abandoned',
] as const;

export type SessionClosedReason = (typeof SESSION_CLOSED_REASONS)[number];

/** Close reasons after which the seat is genuinely gone, so its credential is worthless. */
export const CREDENTIAL_ENDING_REASONS: ReadonlySet<SessionClosedReason> = new Set<SessionClosedReason>([
  'leftVoluntarily',
  'removedByCreator',
]);

/** Everything a session tells the outside world. */
export type SessionUpdate =
  | { readonly type: 'phase'; readonly phase: ConnectionPhase }
  | { readonly type: 'lobby'; readonly lobby: LobbySnapshot }
  | { readonly type: 'publicState'; readonly state: PublicGameState }
  | { readonly type: 'hand'; readonly cards: readonly Card[] }
  | { readonly type: 'events'; readonly events: readonly GameEvent[] }
  | { readonly type: 'actionRejected'; readonly code: RejectionCode; readonly requestId?: string }
  /** One specific intent was applied. The only trustworthy acknowledgement. */
  | { readonly type: 'actionAccepted'; readonly requestId: string; readonly version: number }
  | { readonly type: 'error'; readonly error: SessionError }
  /** Somebody asked the table to hold. */
  | { readonly type: 'paused'; readonly pausedBy: string | null }
  /** It is this player's turn and another player is waiting on them. */
  | { readonly type: 'nudged'; readonly fromPlayerId: string }
  | { readonly type: 'playAgain'; readonly agreed: readonly string[]; readonly required: number }
  | {
      readonly type: 'identity';
      readonly playerId: string;
      readonly resumeToken: string;
      readonly displayName: string;
    }
  | { readonly type: 'closed'; readonly reason: SessionClosedReason };

export type SessionObserver = (update: SessionUpdate) => void;

/** Error codes the user can meaningfully retry. */
const RETRYABLE: ReadonlySet<SessionErrorCode> = new Set<SessionErrorCode>([
  'network',
  'timeout',
  'unknown',
  'roomFull',
  'closed',
]);

export function sessionError(code: SessionErrorCode, detail?: string): SessionError {
  return { code, retryable: RETRYABLE.has(code), ...(detail ? { detail } : {}) };
}

export { RECONNECT_BACKOFF_MS, backoffDelay, reconnectDeadlineMs } from './timing.ts';

/**
 * What the app holds while a player is in a room.
 *
 * There is one implementation now. `role` survives as a literal because a great deal
 * of code reads it, and because 'client' is the honest answer for everybody at the
 * table — including whoever opened it.
 */
export interface Session {
  readonly role: 'client';
  readonly roomCode: string;
  readonly localPlayerId: string;
  destroy(reason: SessionClosedReason): void;
}
