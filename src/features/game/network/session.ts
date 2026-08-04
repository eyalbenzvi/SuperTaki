import type { Card } from '../engine/cards.ts';
import type { GameEvent, RejectionCode } from '../engine/state.ts';
import type { PublicGameState } from '../engine/views.ts';
import type { JoinRejectionReason, LobbySnapshot } from './protocol.ts';
import {
  PROBE_INTERVAL_BUSY_MS,
  silentAfterMs as baseSilentAfterMs,
  unstableAfterMs as baseUnstableAfterMs,
} from './timing.ts';
import type { TransportErrorCode } from './transport.ts';

/** Connection lifecycle, surfaced verbatim in the UI. */
export type ConnectionPhase =
  'idle' | 'initializing' | 'ready' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export type SessionErrorCode = TransportErrorCode | JoinRejectionReason | 'transportUnavailable';

export interface SessionError {
  readonly code: SessionErrorCode;
  /** Technical detail for the debug log; never shown untranslated to players. */
  readonly detail?: string;
  /** Whether the UI should offer a retry button. */
  readonly retryable: boolean;
}

export type SessionClosedReason =
  | 'hostLeft'
  | 'roomReset'
  | 'removedByHost'
  | 'duplicateConnection'
  | 'leftVoluntarily'
  | 'transportFailed'
  /** The round ran out of players. */
  | 'abandoned';

/**
 * Close reasons that end the room, as opposed to interrupting it.
 *
 * The distinction is load-bearing. A client that is told the host has gone used
 * to destroy its transport and latch `destroyed`, after which no amount of
 * preserved credentials or patient backoff could bring it back — so "the host
 * reloads and everyone reconnects" was impossible to build. A host that is merely
 * restarting, or handing over, now says so and the client stays alive.
 */
export const TERMINAL_CLOSE_REASONS: ReadonlySet<SessionClosedReason> = new Set<SessionClosedReason>([
  'hostLeft',
  'roomReset',
  'removedByHost',
  'leftVoluntarily',
  'abandoned',
]);

/** Close reasons after which the seat is genuinely gone, so its credential is worthless. */
export const CREDENTIAL_ENDING_REASONS: ReadonlySet<SessionClosedReason> = new Set<SessionClosedReason>([
  'leftVoluntarily',
  'removedByHost',
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
  /** The room is moving to another device; the client should follow. */
  | { readonly type: 'handover'; readonly successorPeerId: string; readonly generation: number }
  | { readonly type: 'playAgain'; readonly agreed: readonly string[]; readonly required: number }
  | {
      readonly type: 'identity';
      readonly playerId: string;
      readonly resumeToken: string;
      readonly displayName: string;
    }
  | { readonly type: 'closed'; readonly reason: SessionClosedReason };

export type SessionObserver = (update: SessionUpdate) => void;

/** Transport error codes the user can meaningfully retry. */
const RETRYABLE: ReadonlySet<SessionErrorCode> = new Set<SessionErrorCode>([
  'peerUnavailable',
  'signalingUnavailable',
  'network',
  'timeout',
  'unknown',
  'roomFull',
  'closed',
]);

export function sessionError(code: SessionErrorCode, detail?: string): SessionError {
  return { code, retryable: RETRYABLE.has(code), ...(detail ? { detail } : {}) };
}

export {
  RECONNECT_BACKOFF_MS,
  backoffDelay,
  probeInterval,
  reconnectDeadlineMs,
  silentAfterMs,
  unstableAfterMs,
} from './timing.ts';

/**
 * Health thresholds, kept as a compatibility shim over `timing.ts`.
 *
 * The numbers themselves now live in one file with the rest of the hierarchy,
 * because these three were being compared against constants declared elsewhere
 * and drifting from them.
 */
export const HEARTBEAT = {
  intervalMs: PROBE_INTERVAL_BUSY_MS,
  unstableAfterMs: baseUnstableAfterMs(PROBE_INTERVAL_BUSY_MS),
  disconnectedAfterMs: baseSilentAfterMs(PROBE_INTERVAL_BUSY_MS),
} as const;

/** Common shape of the host- and client-side session objects. */
export interface Session {
  readonly role: 'host' | 'client';
  readonly roomCode: string;
  readonly hostPeerId: string;
  readonly localPlayerId: string;
  destroy(reason: SessionClosedReason): void;
}
