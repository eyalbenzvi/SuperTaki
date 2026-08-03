import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import { createLogger } from '../../../lib/logger.ts';
import { isWebRtcSupported, readIceServers, readPeerServerConfig } from './peerConfig.ts';
import {
  CONNECT_TIMEOUT_MS,
  TransportError,
  createEmitter,
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
    case 'disconnected':
      return 'network';
    default:
      return 'unknown';
  }
}

class PeerJsConnection implements TransportConnection {
  private readonly data = createEmitter<[unknown]>();
  private readonly closed = createEmitter<[]>();
  private readonly errors = createEmitter<[TransportError]>();
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
export const READY_TIMEOUT_MS = 20_000;

class PeerJsTransport implements Transport {
  readonly kind = 'peerjs' as const;
  private readonly peer: Peer;
  private readonly incoming = createEmitter<[TransportConnection]>();
  private readonly errors = createEmitter<[TransportError]>();
  private readyPromise: Promise<string>;
  private assignedId: string | null = null;
  private destroyed = false;

  constructor(private readonly options: PeerTransportOptions = {}) {
    const server = readPeerServerConfig();
    const peerOptions: PeerOptions = {
      debug: 0,
      config: { iceServers: readIceServers() },
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
      this.errors.emit(new TransportError(code, error.message, error));
    });

    this.peer.on('disconnected', () => {
      log.warn('signalling disconnected; attempting to reconnect');
      if (!this.destroyed) {
        try {
          this.peer.reconnect();
        } catch (error) {
          log.warn('reconnect failed', error);
        }
      }
    });
  }

  get localId(): string | null {
    return this.assignedId;
  }

  ready(): Promise<string> {
    return this.readyPromise;
  }

  async connect(remoteId: string): Promise<TransportConnection> {
    await this.ready();
    const timeoutMs = this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const connection = this.peer.connect(remoteId, { reliable: true, serialization: 'json' });

    return new Promise<TransportConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          connection.close();
        } catch {
          /* ignore */
        }
        reject(new TransportError('timeout', `Timed out connecting to ${remoteId}`));
      }, timeoutMs);

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

  destroy(): void {
    this.destroyed = true;
    this.incoming.clear();
    this.errors.clear();
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
