import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import { createLogger } from '../../../lib/logger.ts';
import { isWebRtcSupported, readIceServers, readPeerServerConfig } from './peerConfig.ts';
import {
  CONNECT_TIMEOUT_FIRST_MS,
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
  type TransportErrorCode,
} from './transport.ts';

const log = createLogger('peer');

/** Maps PeerJS error types onto our transport error codes. */
function mapErrorType(type: string): TransportErrorCode {
  switch (type) {
    case 'unavailable-id':
      return 'idUnavailable';
    case 'peer-unavailable':
      return 'peerUnavailable';
    case 'browser-incompatible':
      return 'browserUnsupported';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
    case 'ssl-unavailable':
      return 'signalingUnavailable';
    case 'webrtc':
      return 'network';
    /*
     * PeerJS raises `disconnected` when *signalling* is gone, not the peer. The
     * two used to be collapsed into one code, which left the sessions unable to
     * tell "the broker is down" (existing channels are fine, no new ones can be
     * opened) from "the other side left" (the opposite). They need opposite
     * responses, so they get different codes.
     */
    case 'disconnected':
      return 'signalingUnavailable';
    default:
      return 'unknown';
  }
}

/** Reaches through PeerJS for the underlying peer connection, when there is one. */
function peerConnectionOf(connection: DataConnection): RTCPeerConnection | null {
  const candidate = (connection as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
  return candidate ?? null;
}

class PeerJsConnection implements TransportConnection {
  private readonly data = createEmitter<[unknown]>();
  private readonly closed = createEmitter<[]>();
  private readonly errors = createEmitter<[TransportError]>();
  private readonly unstable = createEmitter<[]>();
  private closedEmitted = false;

  constructor(private readonly connection: DataConnection) {
    connection.on('data', (payload) => {
      this.data.emit(payload);
    });
    connection.on('close', () => {
      this.emitClosed();
    });
    connection.on('error', (error: Error & { type?: string }) => {
      this.errors.emit(new TransportError(mapErrorType(error.type ?? ''), error.message, error));
      this.emitClosed();
    });
    connection.on('iceStateChanged', (state) => {
      log.debug('ice state', connection.peer, state);
      /*
       * `disconnected` is recoverable — ICE may still re-nominate a pair — so it
       * is reported as degradation rather than death. Waiting for `failed`, as
       * this once did, means waiting until PeerJS has already closed the
       * connection underneath us, by which point the news is useless.
       */
      if (state === 'disconnected') {
        this.unstable.emit();
        return;
      }
      if (state === 'failed' || state === 'closed') {
        this.errors.emit(new TransportError('network', `ICE connection ${state} for ${connection.peer}`));
        this.emitClosed();
      }
    });
  }

  private emitClosed(): void {
    if (this.closedEmitted) {
      return;
    }
    this.closedEmitted = true;
    this.closed.emit();
  }

  get remoteId(): string {
    return this.connection.peer;
  }

  get open(): boolean {
    return this.connection.open;
  }

  get bufferedAmount(): number {
    const channel = (this.connection as unknown as { dataChannel?: RTCDataChannel }).dataChannel;
    return channel?.bufferedAmount ?? 0;
  }

  send(payload: unknown): void {
    if (!this.connection.open) {
      this.errors.emit(new TransportError('closed', 'Data connection is not open'));
      return;
    }
    try {
      void this.connection.send(payload);
    } catch (error) {
      this.errors.emit(new TransportError('network', 'Failed to send message', error));
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

  async diagnostics(): Promise<ConnectionDiagnostics> {
    const peerConnection = peerConnectionOf(this.connection);
    if (!peerConnection) {
      return { bufferedAmount: this.bufferedAmount };
    }
    const base: ConnectionDiagnostics = {
      iceConnectionState: peerConnection.iceConnectionState,
      connectionState: peerConnection.connectionState,
      bufferedAmount: this.bufferedAmount,
    };
    try {
      const stats = await peerConnection.getStats();
      let pair: RTCIceCandidatePairStats | null = null;
      const candidates = new Map<string, { candidateType?: string; protocol?: string }>();
      // `RTCStatsReport.forEach` hands each report out as `any`, so it is narrowed
      // once here rather than being poked at field by field.
      stats.forEach((raw: unknown) => {
        const report = raw as {
          id?: string;
          type?: string;
          nominated?: boolean;
          candidateType?: string;
          protocol?: string;
        };
        if (report.type === 'candidate-pair' && report.nominated === true) {
          pair = report as RTCIceCandidatePairStats;
        }
        if ((report.type === 'local-candidate' || report.type === 'remote-candidate') && report.id) {
          candidates.set(report.id, {
            ...(report.candidateType ? { candidateType: report.candidateType } : {}),
            ...(report.protocol ? { protocol: report.protocol } : {}),
          });
        }
      });
      if (!pair) {
        return base;
      }
      const nominated: RTCIceCandidatePairStats = pair;
      const local = nominated.localCandidateId ? candidates.get(nominated.localCandidateId) : undefined;
      const remote = nominated.remoteCandidateId ? candidates.get(nominated.remoteCandidateId) : undefined;
      return {
        ...base,
        ...(local?.candidateType ? { localCandidateType: local.candidateType } : {}),
        ...(remote?.candidateType ? { remoteCandidateType: remote.candidateType } : {}),
        ...(local?.protocol ? { candidateProtocol: local.protocol } : {}),
      };
    } catch {
      return base;
    }
  }

  close(): void {
    try {
      this.connection.close();
    } catch (error) {
      log.warn('close failed', error);
    }
    this.emitClosed();
  }
}

export interface PeerTransportOptions {
  /** Requested peer id. Hosts derive it from the room code; clients omit it. */
  readonly id?: string;
  readonly connectTimeoutMs?: number;
  /** How long to wait for the signalling server to assign a peer id. */
  readonly readyTimeoutMs?: number;
}

/**
 * The free public PeerJS broker sometimes accepts a socket and then goes quiet,
 * emitting neither `open` nor `error`. Without a deadline the caller waits for
 * ever: "Create room" spins with no room code and no explanation.
 */
export const READY_TIMEOUT_MS = SIGNALLING_READY_MS;

class PeerJsTransport implements Transport {
  readonly kind = 'peerjs' as const;
  private readonly peer: Peer;
  private readonly incoming = createEmitter<[TransportConnection]>();
  private readonly errors = createEmitter<[TransportError]>();
  private readonly signalling = createEmitter<[SignallingState]>();
  private readyPromise: Promise<string>;
  private assignedId: string | null = null;
  private destroyed = false;
  /** Resolved while signalling is up, replaced by a fresh pending one when it drops. */
  private socketReady: { promise: Promise<void>; resolve: () => void } | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idPermanentlyLost = false;

  constructor(private readonly options: PeerTransportOptions = {}) {
    const server = readPeerServerConfig();
    /*
     * `config` is merged with what PeerJS itself would have used, not substituted
     * for it. Passing this object replaces the library's `DEFAULT_CONFIG`
     * outright, and that default is where the two free community TURN relays
     * live — so the old spread-free version quietly disabled relaying, which is
     * the one thing that makes symmetric-NAT networks work at all.
     */
    const peerOptions: PeerOptions = {
      debug: 0,
      config: { iceServers: readIceServers(), sdpSemantics: 'unified-plan' } as RTCConfiguration,
      ...(server
        ? {
            host: server.host,
            port: server.port,
            path: server.path,
            secure: server.secure,
            ...(server.key ? { key: server.key } : {}),
          }
        : {}),
    };

    this.peer = options.id ? new Peer(options.id, peerOptions) : new Peer(peerOptions);

    this.readyPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.assignedId === null) {
          log.warn('signalling did not assign a peer id in time');
          reject(new TransportError('signalingUnavailable', 'The signalling server did not respond in time'));
        }
      }, options.readyTimeoutMs ?? READY_TIMEOUT_MS);

      const onOpen = (id: string): void => {
        clearTimeout(timer);
        this.assignedId = id;
        log.debug('peer open', id);
        resolve(id);
      };
      const onError = (error: Error & { type?: string }): void => {
        const mapped = new TransportError(mapErrorType(error.type ?? ''), error.message, error);
        if (this.assignedId === null) {
          clearTimeout(timer);
          reject(mapped);
        }
      };
      this.peer.once('open', onOpen);
      this.peer.on('error', onError);
    });

    this.peer.on('connection', (connection) => {
      const wrapped = new PeerJsConnection(connection);
      if (connection.open) {
        this.incoming.emit(wrapped);
        return;
      }
      connection.once('open', () => {
        this.incoming.emit(wrapped);
      });
    });

    this.peer.on('error', (error: Error & { type?: string }) => {
      const code = mapErrorType(error.type ?? '');
      log.warn('peer error', code, error.message);
      /*
       * A taken id ends the reconnect loop. PeerJS's `_abort` calls `disconnect()`
       * rather than `destroy()` once it has a remembered server id, which emits
       * `disconnected` — so a handler that unconditionally reconnects spins
       * forever, one WebSocket per iteration, against a donated service.
       */
      if (code === 'idUnavailable') {
        this.idPermanentlyLost = true;
        this.cancelReconnect();
      }
      this.errors.emit(new TransportError(code, error.message, error));
    });

    this.peer.on('open', () => {
      this.reconnectAttempt = 0;
      this.markSignalling('up');
    });

    this.peer.on('disconnected', () => {
      log.warn('signalling disconnected');
      this.markSignalling('down');
      this.scheduleReconnect();
    });
  }

  // ------------------------------------------------------------------ signalling

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

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Re-registers with the broker, backing off.
   *
   * The unconditional, immediate `reconnect()` this replaces was an unbounded
   * loop whenever the remembered id had been taken in the meantime.
   */
  private scheduleReconnect(): void {
    if (this.destroyed || this.idPermanentlyLost || this.reconnectTimer !== null) {
      return;
    }
    if (this.reconnectAttempt >= RECONNECT_BACKOFF_MS.length) {
      log.warn('giving up on re-registering with the signalling server');
      return;
    }
    const delay = backoffDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed || this.idPermanentlyLost || !this.peer.disconnected || this.peer.destroyed) {
        return;
      }
      try {
        this.peer.reconnect();
      } catch (error) {
        log.warn('reconnect failed', error);
        this.scheduleReconnect();
      }
    }, delay);
  }

  get localId(): string | null {
    return this.assignedId;
  }

  ready(): Promise<string> {
    return this.readyPromise;
  }

  async signallingReady(timeoutMs = SIGNALLING_READY_MS): Promise<void> {
    await this.readyPromise;
    const pending = this.socketReady;
    if (!pending) {
      return;
    }
    this.scheduleReconnect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TransportError('signalingUnavailable', 'Signalling did not come back in time'));
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
    await this.ready();
    const budget = timeoutMs ?? this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_FIRST_MS;
    /*
     * Signalling has to be up *before* the offer, because `Peer.connect()`
     * returns `undefined` outright when the peer is disconnected from the broker
     * — and the caller then dereferences it. Every reconnect path funnels through
     * here, and a wake from a locked phone is precisely when the socket is down.
     *
     * The wait is bounded by the caller's own budget as well as by the signalling
     * deadline, so a short attempt stays short instead of silently becoming a
     * twelve-second one.
     */
    await this.signallingReady(Math.min(SIGNALLING_READY_MS, budget));
    const connection = this.peer.connect(remoteId, { reliable: true, serialization: 'json' }) as
      DataConnection | undefined;
    if (!connection) {
      throw new TransportError('signalingUnavailable', 'Cannot open a connection while signalling is down');
    }

    return new Promise<TransportConnection>((resolve, reject) => {
      const closeQuietly = (): void => {
        try {
          connection.close();
        } catch {
          /* ignore */
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        closeQuietly();
        reject(new TransportError('timeout', `Timed out connecting to ${remoteId}`));
      }, budget);

      const cleanup = (): void => {
        clearTimeout(timer);
        connection.off('open', onOpen);
        connection.off('error', onError);
      };
      const onOpen = (): void => {
        cleanup();
        resolve(new PeerJsConnection(connection));
      };
      const onError = (error: Error & { type?: string }): void => {
        cleanup();
        // Every failed attempt used to leave a live RTCPeerConnection behind,
        // each already holding STUN and TURN allocations.
        closeQuietly();
        reject(new TransportError(mapErrorType(error.type ?? ''), error.message, error));
      };

      connection.once('open', onOpen);
      connection.once('error', onError);
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
    this.destroyed = true;
    this.cancelReconnect();
    this.incoming.clear();
    this.errors.clear();
    this.signalling.clear();
    try {
      this.peer.destroy();
    } catch (error) {
      log.warn('destroy failed', error);
    }
  }
}

export function createPeerTransport(options: PeerTransportOptions = {}): Transport {
  if (!isWebRtcSupported()) {
    throw new TransportError('browserUnsupported', 'This browser does not support WebRTC');
  }
  return new PeerJsTransport(options);
}
