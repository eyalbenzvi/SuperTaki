import { randomHex } from '../../../lib/id.ts';
import { onWake } from '../../../lib/lifecycle.ts';
import { createLogger } from '../../../lib/logger.ts';
import { relayRoomUrl } from './relayConfig.ts';
import { helloFrame, parseServerFrame, routedFrame } from './relayProtocol.ts';
import { roomCodeFromHostPeerId } from './roomCode.ts';
import {
  CONNECT_TIMEOUT_FIRST_MS,
  PROBE_DEADLINE_MS,
  PROBE_INTERVAL_IDLE_MS,
  SIGNALLING_READY_MS,
  backoffDelay,
  RECONNECT_BACKOFF_MS,
} from './timing.ts';
import {
  TransportError,
  createEmitter,
  type ConnectionDiagnostics,
  type SignallingState,
  type Transport,
  type TransportConnection,
} from './transport.ts';

/**
 * The relay transport: every failure mode WebRTC had, removed by not using it.
 *
 * All traffic flows over one plain `wss://` WebSocket to the room's Durable
 * Object, which routes frames between named peers. There is no NAT traversal,
 * no STUN, no TURN, no ICE consent timer, and no signalling channel with a
 * lifetime separate from the data channel's — the socket is both, so "the
 * broker is up but the peer is unreachable" cannot exist. What remains is the
 * one honest failure: the socket is down, and the fix is to reopen it.
 *
 * The transport multiplexes virtual connections ("channels") over the socket
 * so the session layer keeps its familiar shape: `connect()` yields a
 * per-peer `TransportConnection`, incoming channels arrive via `onIncoming`.
 *
 * Reconnection is owned entirely by this file and kept deliberately simple:
 * exponential backoff with jitter, an immediate attempt on any lifecycle wake
 * or `online` event, and a ping/pong probe (answered by the Cloudflare runtime
 * without waking the room) that convicts a half-open socket after a phone
 * comes back from sleep.
 */

const log = createLogger('relay');

/** Consecutive unanswered pings before the socket is declared half-open. */
const PING_MISSES_FATAL = 2;

export interface RelayTransportOptions {
  /** Requested peer id. Hosts derive it from the room code; guests omit it. */
  readonly id?: string;
  /**
   * Proof of ownership for the peer id, minted by the client. Presenting the
   * same claim later is what lets a host reclaim its room after a crash; a
   * guest can let the transport mint a throwaway one.
   */
  readonly claim?: string;
  readonly connectTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
}

interface PendingOpen {
  readonly resolve: (connection: TransportConnection) => void;
  readonly reject: (error: TransportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class RelayConnection implements TransportConnection {
  private readonly data = createEmitter<[unknown]>();
  private readonly closed = createEmitter<[]>();
  private readonly errors = createEmitter<[TransportError]>();
  private readonly unstable = createEmitter<[]>();
  private isOpen = true;

  constructor(
    readonly remoteId: string,
    readonly ch: string,
    private readonly transport: RelayTransport,
  ) {}

  get open(): boolean {
    return this.isOpen;
  }

  get bufferedAmount(): number {
    return this.transport.socketBufferedAmount();
  }

  send(payload: unknown): void {
    if (!this.isOpen) {
      this.errors.emit(new TransportError('closed', 'Connection is not open'));
      return;
    }
    const sent = this.transport.sendRouted('msg', this.remoteId, this.ch, payload);
    if (!sent) {
      this.errors.emit(new TransportError('network', 'The relay socket is down'));
    }
  }

  onData(handler: (payload: unknown) => void): () => void {
    return this.data.add(handler);
  }

  onClose(handler: () => void): () => void {
    return this.closed.add(handler);
  }

  onError(handler: (error: TransportError) => void): () => void {
    return this.errors.add(handler);
  }

  onUnstable(handler: () => void): () => void {
    return this.unstable.add(handler);
  }

  diagnostics(): Promise<ConnectionDiagnostics> {
    return Promise.resolve(this.transport.socketDiagnostics());
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.transport.sendRouted('close', this.remoteId, this.ch);
    this.transport.dropChannel(this);
    this.markClosed();
  }

  /** Internal: data arriving from the remote side. */
  receive(payload: unknown): void {
    this.data.emit(payload);
  }

  /** Internal: the remote side or the transport ended this channel. */
  markClosed(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.closed.emit();
  }

  /** Internal: the path degraded without closing. */
  markUnstable(): void {
    if (this.isOpen) {
      this.unstable.emit();
    }
  }

  /** Internal: a send to this channel's peer failed at the relay. */
  fail(error: TransportError): void {
    this.errors.emit(error);
    this.markClosed();
  }
}

class RelayTransport implements Transport {
  readonly kind = 'relay' as const;

  private readonly incoming = createEmitter<[TransportConnection]>();
  private readonly errors = createEmitter<[TransportError]>();
  private readonly signalling = createEmitter<[SignallingState]>();

  private readonly peerId: string;
  private readonly claim: string;
  private roomCode: string | null;

  private socket: WebSocket | null = null;
  private welcomed = false;
  private assignedId: string | null = null;
  private destroyed = false;
  private idPermanentlyLost = false;

  /** `${peerId}/${ch}` → live channel. */
  private readonly channels = new Map<string, RelayConnection>();
  /** `${peerId}/${ch}` → connect() waiting for its accept. */
  private readonly pendingOpens = new Map<string, PendingOpen>();

  private readyPromise: Promise<string>;
  private resolveReady: ((id: string) => void) | null = null;
  private rejectReady: ((error: TransportError) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private readySettled = false;

  /** Resolved while the socket is welcomed; pending while it is not. */
  private socketReady: { promise: Promise<void>; resolve: () => void } | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingDeadline: ReturnType<typeof setTimeout> | null = null;
  private pingMisses = 0;

  private readonly detachWake: () => void;

  constructor(private readonly options: RelayTransportOptions = {}) {
    this.peerId = options.id ?? `p-${randomHex(8)}`;
    this.claim = options.claim ?? randomHex(16);
    this.roomCode = options.id ? roomCodeFromHostPeerId(options.id) : null;
    if (options.id && this.roomCode === null) {
      throw new TransportError('unknown', `Peer id ${options.id} does not name a room`);
    }

    this.readyPromise = new Promise<string>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Nobody should learn about a failed room claim from an unhandled-rejection
    // banner; callers that care call `ready()` themselves.
    this.readyPromise.catch(() => undefined);

    if (this.roomCode !== null) {
      // A host binds and registers immediately: its whole purpose is to be
      // reachable at this id, and a claim conflict must surface now.
      this.armReadyTimer();
      this.ensureSocket();
    } else {
      // A guest has nothing to wait for until it knows which room to join.
      this.settleReady(this.peerId);
    }

    this.detachWake = onWake(() => {
      this.onWake();
    });
  }

  // ------------------------------------------------------------------ ready

  private armReadyTimer(): void {
    const budget = this.options.readyTimeoutMs ?? SIGNALLING_READY_MS;
    this.readyTimer = setTimeout(() => {
      this.failReady(new TransportError('signalingUnavailable', 'The relay did not respond in time'));
    }, budget);
  }

  private settleReady(id: string): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.assignedId = id;
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.resolveReady?.(id);
  }

  private failReady(error: TransportError): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.rejectReady?.(error);
  }

  get localId(): string | null {
    return this.assignedId;
  }

  ready(): Promise<string> {
    return this.readyPromise;
  }

  // ------------------------------------------------------------------ socket

  private markSignalling(state: SignallingState): void {
    if (state === 'down') {
      if (this.socketReady === null) {
        let resolve = (): void => {};
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        this.socketReady = { promise, resolve };
        this.signalling.emit('down');
      }
      return;
    }
    const pending = this.socketReady;
    this.socketReady = null;
    if (pending) {
      pending.resolve();
      this.signalling.emit('up');
    }
  }

  /** Opens the socket if the transport is bound to a room and none is live. */
  private ensureSocket(): void {
    if (this.destroyed || this.idPermanentlyLost || this.roomCode === null) {
      return;
    }
    if (
      this.socket !== null &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const url = relayRoomUrl(this.roomCode);
    if (url === null) {
      this.markSignalling('down');
      const error = new TransportError('signalingUnavailable', 'No relay is configured for this build');
      this.errors.emit(error);
      this.failReady(error);
      return;
    }
    this.markSignalling('down');
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      log.warn('could not open the relay socket', error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      socket.send(helloFrame(this.peerId, this.claim));
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.socket === socket && typeof event.data === 'string') {
        this.onFrame(event.data);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.onSocketDown();
    };
    socket.onerror = () => {
      // Always followed by `close`; nothing useful is in the event.
    };
  }

  private onSocketDown(): void {
    this.socket = null;
    this.welcomed = false;
    this.stopPinging();
    this.markSignalling('down');
    /*
     * The room has already told everybody we left, and forgot which channels
     * we carried — pretending ours are still open would recreate exactly the
     * half-open limbo this transport exists to remove. Close them honestly;
     * the sessions' own reconnect logic opens fresh ones.
     */
    this.closeAllChannels();
    if (!this.destroyed && !this.idPermanentlyLost) {
      this.scheduleReconnect();
    }
  }

  private closeAllChannels(): void {
    const open = [...this.channels.values()];
    this.channels.clear();
    for (const channel of open) {
      channel.markClosed();
    }
    const pending = [...this.pendingOpens.values()];
    this.pendingOpens.clear();
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new TransportError('network', 'The relay socket closed during connect'));
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.idPermanentlyLost || this.reconnectTimer !== null || this.roomCode === null) {
      return;
    }
    if (this.reconnectAttempt >= RECONNECT_BACKOFF_MS.length) {
      log.warn('giving up on the relay until someone asks again');
      return;
    }
    const delay = backoffDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delay);
  }

  private onWake(): void {
    if (this.destroyed || this.idPermanentlyLost || this.roomCode === null) {
      return;
    }
    if (
      this.socket === null ||
      this.socket.readyState === WebSocket.CLOSED ||
      this.socket.readyState === WebSocket.CLOSING
    ) {
      // A wake is new information: start the ladder from the bottom.
      this.reconnectAttempt = 0;
      this.cancelReconnect();
      this.ensureSocket();
      return;
    }
    if (this.welcomed) {
      // The socket looks open, but a sleeping phone tears connections down
      // without telling anybody. One probe answers the question now.
      this.probe(PROBE_DEADLINE_MS);
    }
  }

  // ------------------------------------------------------------------ frames

  private onFrame(raw: string): void {
    if (raw === 'pong') {
      this.pingMisses = 0;
      if (this.pingDeadline !== null) {
        clearTimeout(this.pingDeadline);
        this.pingDeadline = null;
      }
      return;
    }
    const frame = parseServerFrame(raw);
    if (frame === null) {
      log.warn('dropping an unreadable frame from the relay');
      return;
    }
    switch (frame.t) {
      case 'welcome':
        this.welcomed = true;
        this.reconnectAttempt = 0;
        this.pingMisses = 0;
        this.settleReady(this.peerId);
        this.markSignalling('up');
        this.startPinging();
        return;
      case 'denied':
        this.onDenied(frame.reason);
        return;
      case 'peerUp':
        return;
      case 'peerDown':
        this.onPeerDown(frame.peerId);
        return;
      case 'gone':
        this.onGone(frame.peerId, frame.ch);
        return;
      case 'open':
        this.onOpen(frame.from, frame.ch);
        return;
      case 'accept':
        this.onAccept(frame.from, frame.ch);
        return;
      case 'msg':
        this.channels.get(`${frame.from}/${frame.ch}`)?.receive(frame.d);
        return;
      case 'close': {
        const key = `${frame.from}/${frame.ch}`;
        const channel = this.channels.get(key);
        if (channel !== undefined) {
          this.channels.delete(key);
          channel.markClosed();
        }
        return;
      }
    }
  }

  private onDenied(reason: 'idTaken' | 'badHello' | 'protocolVersion'): void {
    const error =
      reason === 'idTaken'
        ? new TransportError('idUnavailable', `The id ${this.peerId} is held by someone else`)
        : new TransportError('unknown', `The relay refused the connection: ${reason}`);
    if (reason === 'idTaken') {
      // Retrying with the same id and claim would be denied for ever.
      this.idPermanentlyLost = true;
      this.cancelReconnect();
    }
    this.failReady(error);
    this.errors.emit(error);
  }

  private onPeerDown(peerId: string): void {
    const prefix = `${peerId}/`;
    for (const [key, channel] of [...this.channels.entries()]) {
      if (key.startsWith(prefix)) {
        this.channels.delete(key);
        channel.markClosed();
      }
    }
    for (const [key, waiter] of [...this.pendingOpens.entries()]) {
      if (key.startsWith(prefix)) {
        this.pendingOpens.delete(key);
        clearTimeout(waiter.timer);
        waiter.reject(new TransportError('peerUnavailable', `${peerId} left the room`));
      }
    }
  }

  private onGone(peerId: string, ch: string): void {
    const key = `${peerId}/${ch}`;
    const waiter = this.pendingOpens.get(key);
    if (waiter !== undefined) {
      this.pendingOpens.delete(key);
      clearTimeout(waiter.timer);
      waiter.reject(new TransportError('peerUnavailable', `${peerId} is not in the room`));
      return;
    }
    const channel = this.channels.get(key);
    if (channel !== undefined) {
      this.channels.delete(key);
      channel.fail(new TransportError('peerUnavailable', `${peerId} is no longer in the room`));
    }
  }

  private onOpen(from: string, ch: string): void {
    const key = `${from}/${ch}`;
    const existing = this.channels.get(key);
    if (existing !== undefined) {
      // A duplicate open: our accept was lost somewhere. Re-accepting is
      // harmless; announcing a second incoming connection is not.
      this.sendRouted('accept', from, ch);
      return;
    }
    const connection = new RelayConnection(from, ch, this);
    this.channels.set(key, connection);
    this.sendRouted('accept', from, ch);
    this.incoming.emit(connection);
  }

  private onAccept(from: string, ch: string): void {
    const key = `${from}/${ch}`;
    const waiter = this.pendingOpens.get(key);
    if (waiter === undefined) {
      return;
    }
    this.pendingOpens.delete(key);
    clearTimeout(waiter.timer);
    const connection = new RelayConnection(from, ch, this);
    this.channels.set(key, connection);
    waiter.resolve(connection);
  }

  // ------------------------------------------------------------------ pings

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = setInterval(() => {
      this.probe(PROBE_DEADLINE_MS);
    }, PROBE_INTERVAL_IDLE_MS);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pingDeadline !== null) {
      clearTimeout(this.pingDeadline);
      this.pingDeadline = null;
    }
    this.pingMisses = 0;
  }

  /** Sends one ping and convicts the socket if the pong misses its deadline. */
  private probe(deadlineMs: number): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN || this.pingDeadline !== null) {
      return;
    }
    try {
      this.socket.send('ping');
    } catch {
      return;
    }
    this.pingDeadline = setTimeout(() => {
      this.pingDeadline = null;
      this.pingMisses += 1;
      if (this.pingMisses === 1) {
        for (const channel of this.channels.values()) {
          channel.markUnstable();
        }
      }
      if (this.pingMisses >= PING_MISSES_FATAL && this.socket !== null) {
        log.warn('relay socket is half-open; forcing a reconnect');
        // `close()` on a dead TCP connection can dawdle for a whole TCP
        // timeout; the reconnect must not wait for it, so the down path is
        // taken directly and the old socket's own close event is silenced.
        const socket = this.socket;
        try {
          socket.onclose = null;
          socket.close();
        } catch {
          /* already dead */
        }
        this.onSocketDown();
      }
    }, deadlineMs);
  }

  // ------------------------------------------------------------------ transport API

  async signallingReady(timeoutMs = SIGNALLING_READY_MS): Promise<void> {
    if (this.destroyed) {
      throw new TransportError('closed', 'The transport is destroyed');
    }
    if (this.roomCode === null || this.welcomed) {
      return;
    }
    if (this.idPermanentlyLost) {
      throw new TransportError('idUnavailable', `The id ${this.peerId} is held by someone else`);
    }
    // Somebody asking is new information: re-arm the ladder if it ran out.
    if (this.reconnectAttempt >= RECONNECT_BACKOFF_MS.length) {
      this.reconnectAttempt = 0;
    }
    this.ensureSocket();
    this.scheduleReconnect();
    const pending = this.socketReady;
    if (pending === null) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TransportError('signalingUnavailable', 'The relay did not come back in time'));
      }, timeoutMs);
    });
    try {
      await Promise.race([pending.promise, deadline]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async connect(remoteId: string, timeoutMs?: number): Promise<TransportConnection> {
    if (this.destroyed) {
      throw new TransportError('closed', 'The transport is destroyed');
    }
    const budget = timeoutMs ?? this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_FIRST_MS;
    if (this.roomCode === null) {
      const code = roomCodeFromHostPeerId(remoteId);
      if (code === null) {
        throw new TransportError('peerUnavailable', `${remoteId} does not name a room`);
      }
      this.roomCode = code;
      this.ensureSocket();
    }
    await this.signallingReady(Math.min(SIGNALLING_READY_MS, budget));

    const ch = `c-${randomHex(4)}`;
    const key = `${remoteId}/${ch}`;
    return new Promise<TransportConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOpens.delete(key);
        reject(new TransportError('timeout', `Timed out connecting to ${remoteId}`));
      }, budget);
      this.pendingOpens.set(key, { resolve, reject, timer });
      const sent = this.sendRouted('open', remoteId, ch);
      if (!sent) {
        this.pendingOpens.delete(key);
        clearTimeout(timer);
        reject(new TransportError('signalingUnavailable', 'Cannot connect while the relay socket is down'));
      }
    });
  }

  onIncoming(handler: (connection: TransportConnection) => void): () => void {
    return this.incoming.add(handler);
  }

  onError(handler: (error: TransportError) => void): () => void {
    return this.errors.add(handler);
  }

  onSignallingChange(handler: (state: SignallingState) => void): () => void {
    return this.signalling.add(handler);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.detachWake();
    this.cancelReconnect();
    this.stopPinging();
    this.failReady(new TransportError('closed', 'The transport was destroyed'));
    this.closeAllChannels();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.onclose = null;
        socket.close(1000, 'bye');
      } catch {
        /* already closed */
      }
    }
    this.incoming.clear();
    this.errors.clear();
    this.signalling.clear();
  }

  // ------------------------------------------------------------------ helpers for connections

  /** Sends a routed frame if the socket is welcomed. Returns whether it went out. */
  sendRouted(t: 'open' | 'accept' | 'msg' | 'close', to: string, ch: string, d?: unknown): boolean {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN || !this.welcomed) {
      return false;
    }
    try {
      this.socket.send(routedFrame(t, to, ch, d));
      return true;
    } catch (error) {
      log.warn('send failed', error);
      return false;
    }
  }

  dropChannel(connection: RelayConnection): void {
    this.channels.delete(`${connection.remoteId}/${connection.ch}`);
  }

  socketBufferedAmount(): number {
    return this.socket?.bufferedAmount ?? 0;
  }

  socketDiagnostics(): ConnectionDiagnostics {
    return {
      connectionState: this.welcomed ? 'connected' : 'connecting',
      candidateProtocol: 'websocket',
      bufferedAmount: this.socketBufferedAmount(),
    };
  }
}

export function createRelayTransport(options: RelayTransportOptions = {}): Transport {
  if (typeof WebSocket === 'undefined') {
    throw new TransportError('browserUnsupported', 'This browser does not support WebSocket');
  }
  return new RelayTransport(options);
}
