/**
 * Transport abstraction.
 *
 * The lobby/game sessions only ever talk to this interface, which keeps PeerJS
 * out of the game logic and makes deterministic testing possible:
 * - `peerjs`    — real WebRTC data channels (production)
 * - `broadcast` — BroadcastChannel between tabs of the same browser
 *                 (end-to-end tests, and same-device play)
 * - `memory`    — in-process, used by unit tests
 */

export type TransportKind = 'peerjs' | 'broadcast' | 'memory';

export type TransportErrorCode =
  | 'idUnavailable'
  | 'peerUnavailable'
  | 'signalingUnavailable'
  | 'browserUnsupported'
  | 'network'
  | 'timeout'
  | 'closed'
  | 'unknown';

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    readonly sourceError?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * What a connection can tell us about *why* it is unwell.
 *
 * Every field is optional because only the WebRTC transport can answer any of
 * them, and the answers are what distinguish "we never had a path" from "our path
 * died" — a distinction no amount of timing data can recover after the fact.
 */
export interface ConnectionDiagnostics {
  /** ICE candidate type at each end of the pair actually in use. */
  readonly localCandidateType?: string;
  readonly remoteCandidateType?: string;
  readonly candidateProtocol?: string;
  readonly iceConnectionState?: string;
  readonly connectionState?: string;
  /** Bytes still waiting in the send buffer. A rising value is a stalled path. */
  readonly bufferedAmount?: number;
}

export interface TransportConnection {
  /** Peer id of the other side. */
  readonly remoteId: string;
  readonly open: boolean;
  /**
   * Bytes queued locally and not yet handed to the network.
   *
   * `open` staying true while this climbs is the signature of a path that has
   * stopped working without anybody being told.
   */
  readonly bufferedAmount: number;
  /** Sends a JSON-serialisable value. Never throws; failures surface via `onError`. */
  send(data: unknown): void;
  onData(handler: (data: unknown) => void): () => void;
  onClose(handler: () => void): () => void;
  onError(handler: (error: TransportError) => void): () => void;
  /**
   * Fires when the path degrades without closing — the state in which `open` is
   * still true and nothing works.
   */
  onUnstable(handler: () => void): () => void;
  /** Best-effort snapshot for the diagnostics log. Resolves to `{}` when unsupported. */
  diagnostics(): Promise<ConnectionDiagnostics>;
  close(): void;
}

/** Whether the signalling channel — not the peer — is currently usable. */
export type SignallingState = 'up' | 'down';

export interface Transport {
  readonly kind: TransportKind;
  /** Assigned local peer id, or `null` before the transport is ready. */
  readonly localId: string | null;
  /** Resolves with the local peer id once signalling is established. */
  ready(): Promise<string>;
  /**
   * Resolves once signalling is usable *again* after a drop, or rejects on a
   * deadline.
   *
   * Without this, a reconnect attempt during a network handover issues a connect
   * on a peer whose socket is dead and pays the whole connect budget discovering
   * that nothing happened.
   */
  signallingReady(timeoutMs?: number): Promise<void>;
  /** Opens a data connection to a remote peer id. */
  connect(remoteId: string, timeoutMs?: number): Promise<TransportConnection>;
  /** Subscribes to inbound connections. Returns an unsubscribe function. */
  onIncoming(handler: (connection: TransportConnection) => void): () => void;
  /** Subscribes to transport-level failures (signalling down, id taken, ...). */
  onError(handler: (error: TransportError) => void): () => void;
  /** Subscribes to signalling coming and going, which is not the same as a peer leaving. */
  onSignallingChange(handler: (state: SignallingState) => void): () => void;
  destroy(): void;
}

/** Minimal typed event emitter used by the transport implementations. */
export function createEmitter<TArgs extends unknown[]>(): {
  add: (handler: (...args: TArgs) => void) => () => void;
  emit: (...args: TArgs) => void;
  clear: () => void;
  readonly size: number;
} {
  const handlers = new Set<(...args: TArgs) => void>();
  return {
    add(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(...args) {
      for (const handler of [...handlers]) {
        handler(...args);
      }
    },
    clear() {
      handlers.clear();
    },
    get size() {
      return handlers.size;
    },
  };
}

export { CONNECT_TIMEOUT_FIRST_MS as CONNECT_TIMEOUT_MS } from './timing.ts';
