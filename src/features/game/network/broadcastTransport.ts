import { randomHex } from '../../../lib/id.ts';
import { createLogger } from '../../../lib/logger.ts';
import {
  TransportError,
  createEmitter,
  type ConnectionDiagnostics,
  type SignallingState,
  type Transport,
  type TransportConnection,
} from './transport.ts';

/**
 * BroadcastChannel transport: connects tabs of the *same browser and origin*.
 *
 * It exists for two reasons:
 * 1. Deterministic end-to-end tests — Playwright can drive several pages
 *    without depending on public signalling servers or NAT traversal.
 * 2. Same-device play (e.g. passing a tablet around, or two windows).
 *
 * It is selected with `?transport=broadcast` and is never the default.
 */

const CONTROL_CHANNEL = 'superTaki:bc:control';
const DATA_CHANNEL_PREFIX = 'superTaki:bc:session:';
const HANDSHAKE_TIMEOUT_MS = 3_000;

const log = createLogger('broadcast');

interface ControlConnect {
  kind: 'connect';
  from: string;
  to: string;
  session: string;
}
interface ControlAccept {
  kind: 'accept';
  from: string;
  to: string;
  session: string;
}
type ControlMessage = ControlConnect | ControlAccept;

function isControlMessage(value: unknown): value is ControlMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ControlMessage>;
  return (
    (candidate.kind === 'connect' || candidate.kind === 'accept') &&
    typeof candidate.from === 'string' &&
    typeof candidate.to === 'string' &&
    typeof candidate.session === 'string'
  );
}

interface DataFrame {
  kind: 'data' | 'close';
  from: string;
  payload?: unknown;
}

class BroadcastConnection implements TransportConnection {
  private readonly data = createEmitter<[unknown]>();
  private readonly closed = createEmitter<[]>();
  private readonly errors = createEmitter<[TransportError]>();
  private readonly unstable = createEmitter<[]>();
  private readonly channel: BroadcastChannel;
  private isOpen = true;

  constructor(
    readonly remoteId: string,
    private readonly localId: string,
    sessionId: string,
  ) {
    this.channel = new BroadcastChannel(DATA_CHANNEL_PREFIX + sessionId);
    this.channel.onmessage = (event: MessageEvent<unknown>) => {
      const frame = event.data as DataFrame | null;
      if (!frame || typeof frame !== 'object' || frame.from === this.localId) {
        return;
      }
      if (frame.kind === 'close') {
        this.handleRemoteClose();
        return;
      }
      if (frame.kind === 'data') {
        this.data.emit(frame.payload);
      }
    };
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** A BroadcastChannel post is delivered or it throws; nothing is ever queued. */
  get bufferedAmount(): number {
    return 0;
  }

  send(payload: unknown): void {
    if (!this.isOpen) {
      this.errors.emit(new TransportError('closed', 'Connection is closed'));
      return;
    }
    try {
      this.channel.postMessage({ kind: 'data', from: this.localId, payload } satisfies DataFrame);
    } catch (error) {
      this.errors.emit(new TransportError('network', 'Failed to post message', error));
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

  /** Same-browser channels do not degrade: they work or they are closed. */
  onUnstable(handler: () => void): () => void {
    return this.unstable.add(handler);
  }

  diagnostics(): Promise<ConnectionDiagnostics> {
    return Promise.resolve({ bufferedAmount: 0 });
  }

  private handleRemoteClose(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.closed.emit();
    this.channel.close();
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    try {
      this.channel.postMessage({ kind: 'close', from: this.localId } satisfies DataFrame);
    } catch {
      /* ignore */
    }
    this.closed.emit();
    this.channel.close();
  }
}

class BroadcastTransport implements Transport {
  readonly kind = 'broadcast' as const;
  private readonly incoming = createEmitter<[TransportConnection]>();
  private readonly errors = createEmitter<[TransportError]>();
  private readonly signalling = createEmitter<[SignallingState]>();
  private readonly control: BroadcastChannel;
  private readonly pending = new Map<string, (connection: TransportConnection) => void>();
  private destroyed = false;

  constructor(readonly localId: string) {
    this.control = new BroadcastChannel(CONTROL_CHANNEL);
    this.control.onmessage = (event: MessageEvent<unknown>) => {
      if (!isControlMessage(event.data) || event.data.to !== this.localId) {
        return;
      }
      const message = event.data;
      if (message.kind === 'connect') {
        log.debug('incoming connect from', message.from);
        const connection = new BroadcastConnection(message.from, this.localId, message.session);
        this.control.postMessage({
          kind: 'accept',
          from: this.localId,
          to: message.from,
          session: message.session,
        } satisfies ControlAccept);
        this.incoming.emit(connection);
        return;
      }
      const resolve = this.pending.get(message.session);
      if (resolve) {
        this.pending.delete(message.session);
        resolve(new BroadcastConnection(message.from, this.localId, message.session));
      }
    };
  }

  ready(): Promise<string> {
    return this.destroyed
      ? Promise.reject(new TransportError('closed', 'Transport destroyed'))
      : Promise.resolve(this.localId);
  }

  /** There is no broker to lose: within one browser, signalling is always up. */
  signallingReady(): Promise<void> {
    return this.destroyed
      ? Promise.reject(new TransportError('closed', 'Transport destroyed'))
      : Promise.resolve();
  }

  connect(remoteId: string): Promise<TransportConnection> {
    if (this.destroyed) {
      return Promise.reject(new TransportError('closed', 'Transport destroyed'));
    }
    const session = randomHex(8);
    return new Promise<TransportConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(session);
        reject(new TransportError('peerUnavailable', `No local tab is hosting ${remoteId}`));
      }, HANDSHAKE_TIMEOUT_MS);

      this.pending.set(session, (connection) => {
        clearTimeout(timer);
        resolve(connection);
      });

      this.control.postMessage({
        kind: 'connect',
        from: this.localId,
        to: remoteId,
        session,
      } satisfies ControlConnect);
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
    this.incoming.clear();
    this.errors.clear();
    this.signalling.clear();
    this.pending.clear();
    this.control.close();
  }
}

export function isBroadcastSupported(): boolean {
  return typeof BroadcastChannel === 'function';
}

export function createBroadcastTransport(id?: string): Transport {
  if (!isBroadcastSupported()) {
    throw new TransportError('browserUnsupported', 'BroadcastChannel is not available');
  }
  return new BroadcastTransport(id ?? `bc-${randomHex(6)}`);
}
