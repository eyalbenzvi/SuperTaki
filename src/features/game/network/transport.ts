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

export interface TransportConnection {
  /** Peer id of the other side. */
  readonly remoteId: string;
  readonly open: boolean;
  /** Sends a JSON-serialisable value. Never throws; failures surface via `onError`. */
  send(data: unknown): void;
  onData(handler: (data: unknown) => void): () => void;
  onClose(handler: () => void): () => void;
  onError(handler: (error: TransportError) => void): () => void;
  close(): void;
}

export interface Transport {
  readonly kind: TransportKind;
  /** Assigned local peer id, or `null` before the transport is ready. */
  readonly localId: string | null;
  /** Resolves with the local peer id once signalling is established. */
  ready(): Promise<string>;
  /** Opens a data connection to a remote peer id. */
  connect(remoteId: string): Promise<TransportConnection>;
  /** Subscribes to inbound connections. Returns an unsubscribe function. */
  onIncoming(handler: (connection: TransportConnection) => void): () => void;
  /** Subscribes to transport-level failures (signalling down, id taken, ...). */
  onError(handler: (error: TransportError) => void): () => void;
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

export const CONNECT_TIMEOUT_MS = 15_000;
