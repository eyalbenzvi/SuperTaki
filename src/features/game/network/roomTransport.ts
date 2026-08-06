/**
 * One WebSocket to one room.
 *
 * This replaces `relayTransport.ts`, and most of it is what was deleted rather than
 * what was written. The relay transport multiplexed virtual channels over a socket,
 * arbitrated ownership of a peer id with a minted claim, tracked which peers were
 * present, and ran a reconnection loop of its own underneath the session's. All four
 * existed to reach *another browser*. There is one destination now — the room — and
 * the socket is the connection to it, so what is left is: open it, notice when it
 * dies, and notice when it is lying about being alive.
 *
 * The reconnection loop went with them. There used to be two, stacked: this layer
 * rebuilt the socket while `clientSession` rebuilt the channel over it, each with its
 * own backoff, each unaware of the other's attempt. That is one loop now, owned by
 * the session, because there is only one thing left to rebuild.
 */

import { createLogger } from '../../../lib/logger.ts';
import { relayRoomUrl } from './relayConfig.ts';
import { CONNECT_TIMEOUT_FIRST_MS, PROBE_DEADLINE_MS, PROBE_INTERVAL_IDLE_MS } from './timing.ts';

const log = createLogger('room');

/**
 * The liveness probe. Must match the worker's `PROBE_REQUEST`/`PROBE_RESPONSE`.
 *
 * A bare string rather than a game message, and that is a cost decision: these are
 * registered with the Durable Object's auto-responder, so the Cloudflare runtime
 * answers them while the room stays hibernated. A `ping` *message* would wake the
 * room, on a cadence, for every player, for as long as the room lived — which is
 * the one bill this architecture is designed not to run up.
 */
const PROBE_REQUEST = 'ping';
const PROBE_RESPONSE = 'pong';

/** Consecutive unanswered probes before the socket is declared half-open. */
const PROBE_MISSES_FATAL = 2;

export const ROOM_ERROR_CODES = [
  /** No room worker is configured for this build. */
  'notConfigured',
  'browserUnsupported',
  'network',
  'timeout',
  'closed',
  'unknown',
] as const;

export type RoomErrorCode = (typeof ROOM_ERROR_CODES)[number];

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

export interface RoomChannel {
  readonly open: boolean;
  /** Sends a JSON-serialisable value. Never throws; a dead socket simply drops it. */
  send(data: unknown): void;
  onData(handler: (data: unknown) => void): () => void;
  onClose(handler: () => void): () => void;
  /** Fires when the path degrades without closing — `open` is true and nothing works. */
  onUnstable(handler: () => void): () => void;
  /** Asks the socket to prove it is alive now, on a short deadline. */
  probe(deadlineMs?: number): void;
  close(): void;
}

/** How a session gets a channel. Injectable, so tests need no WebSocket at all. */
export type ChannelFactory = (roomCode: string, timeoutMs?: number) => Promise<RoomChannel>;

function emitter<TArgs extends unknown[]>(): {
  add: (handler: (...args: TArgs) => void) => () => void;
  emit: (...args: TArgs) => void;
  clear: () => void;
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
  };
}

class WebSocketChannel implements RoomChannel {
  private readonly data = emitter<[unknown]>();
  private readonly closed = emitter<[]>();
  private readonly unstable = emitter<[]>();
  private isOpen = true;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private probeDeadline: ReturnType<typeof setTimeout> | null = null;
  private misses = 0;

  constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') {
        return;
      }
      if (event.data === PROBE_RESPONSE) {
        this.misses = 0;
        if (this.probeDeadline !== null) {
          clearTimeout(this.probeDeadline);
          this.probeDeadline = null;
        }
        return;
      }
      try {
        this.data.emit(JSON.parse(event.data));
      } catch {
        log.warn('dropping an unreadable frame from the room');
      }
    };
    socket.onclose = () => {
      this.markClosed();
    };
    socket.onerror = () => {
      // Always followed by `close`; nothing useful is in the event.
    };
    this.probeTimer = setInterval(() => {
      this.probe();
    }, PROBE_INTERVAL_IDLE_MS);
  }

  get open(): boolean {
    return this.isOpen && this.socket.readyState === WebSocket.OPEN;
  }

  send(payload: unknown): void {
    if (!this.open) {
      return;
    }
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      log.warn('send failed', error);
    }
  }

  onData(handler: (payload: unknown) => void): () => void {
    return this.data.add(handler);
  }

  onClose(handler: () => void): () => void {
    return this.closed.add(handler);
  }

  onUnstable(handler: () => void): () => void {
    return this.unstable.add(handler);
  }

  /**
   * Sends one probe and convicts the socket if the answer misses its deadline.
   *
   * The case this exists for: a phone comes back from sleep with `readyState` still
   * `OPEN` on a TCP connection that died minutes ago. Nothing about the socket says
   * so, and no amount of waiting will — the only way to find out is to ask.
   */
  probe(deadlineMs: number = PROBE_DEADLINE_MS): void {
    if (!this.open || this.probeDeadline !== null) {
      return;
    }
    try {
      this.socket.send(PROBE_REQUEST);
    } catch {
      return;
    }
    this.probeDeadline = setTimeout(() => {
      this.probeDeadline = null;
      this.misses += 1;
      if (this.misses === 1) {
        this.unstable.emit();
      }
      if (this.misses >= PROBE_MISSES_FATAL) {
        log.warn('the room socket is half-open; tearing it down');
        /*
         * `close()` on a dead TCP connection can sit there for a whole TCP timeout,
         * and the reconnect must not wait for it — so the close path is taken
         * directly and the socket's own event is silenced.
         */
        try {
          this.socket.onclose = null;
          this.socket.close();
        } catch {
          /* already dead */
        }
        this.markClosed();
      }
    }, deadlineMs);
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    try {
      this.socket.onclose = null;
      this.socket.close(1000, 'bye');
    } catch {
      /* already closing */
    }
    this.markClosed();
  }

  private markClosed(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    if (this.probeTimer !== null) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.probeDeadline !== null) {
      clearTimeout(this.probeDeadline);
      this.probeDeadline = null;
    }
    this.closed.emit();
    this.data.clear();
    this.unstable.clear();
  }
}

/** Opens a socket to a room, or rejects with why it could not. */
export const openRoomChannel: ChannelFactory = (roomCode, timeoutMs = CONNECT_TIMEOUT_FIRST_MS) => {
  if (typeof WebSocket === 'undefined') {
    return Promise.reject(new RoomError('browserUnsupported', 'This browser does not support WebSocket'));
  }
  const url = relayRoomUrl(roomCode);
  if (url === null) {
    return Promise.reject(new RoomError('notConfigured', 'No room server is configured for this build'));
  }

  return new Promise<RoomChannel>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(new RoomError('network', `Could not open a socket: ${String(error)}`));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.onclose = null;
        socket.close();
      } catch {
        /* nothing to close */
      }
      reject(new RoomError('timeout', 'The room did not answer in time'));
    }, timeoutMs);

    socket.onopen = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(new WebSocketChannel(socket));
    };
    socket.onclose = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new RoomError('network', 'The room socket closed before it opened'));
    };
  });
};
