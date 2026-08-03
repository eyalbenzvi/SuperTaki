import type { Card } from '../engine/cards.ts';
import type { GameEvent, RejectionCode } from '../engine/state.ts';
import type { PublicGameState } from '../engine/views.ts';
import type { JoinRejectionReason, LobbySnapshot } from './protocol.ts';
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
  'hostLeft' | 'roomReset' | 'removedByHost' | 'duplicateConnection' | 'leftVoluntarily' | 'transportFailed';

/** Everything a session tells the outside world. */
export type SessionUpdate =
  | { readonly type: 'phase'; readonly phase: ConnectionPhase }
  | { readonly type: 'lobby'; readonly lobby: LobbySnapshot }
  | { readonly type: 'publicState'; readonly state: PublicGameState }
  | { readonly type: 'hand'; readonly cards: readonly Card[] }
  | { readonly type: 'events'; readonly events: readonly GameEvent[] }
  | { readonly type: 'actionRejected'; readonly code: RejectionCode }
  | { readonly type: 'error'; readonly error: SessionError }
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

/** Health thresholds, shared by host and client heartbeats. */
export const HEARTBEAT = {
  intervalMs: 5_000,
  unstableAfterMs: 9_000,
  disconnectedAfterMs: 20_000,
} as const;

/** Bounded exponential backoff for reconnection attempts. */
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 12_000] as const;

export function backoffDelay(attempt: number): number {
  const index = Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1);
  return RECONNECT_BACKOFF_MS[index] as number;
}

/** Common shape of the host- and client-side session objects. */
export interface Session {
  readonly role: 'host' | 'client';
  readonly roomCode: string;
  readonly hostPeerId: string;
  readonly localPlayerId: string;
  destroy(reason: SessionClosedReason): void;
}
