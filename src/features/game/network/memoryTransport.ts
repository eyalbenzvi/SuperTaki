import { randomHex } from '../../../lib/id.ts';
import {
  TransportError,
  createEmitter,
  type ConnectionDiagnostics,
  type SignallingState,
  type Transport,
  type TransportConnection,
} from './transport.ts';

/**
 * In-process transport used by tests: no timers, no browser APIs, delivery on a
 * microtask so ordering matches a real data channel closely enough.
 *
 * It also models the failures a real data channel has and a naive fake does not.
 * That matters more than it sounds: without them, `open` is a boolean that only
 * an explicit `close()` ever clears, delivery is perfect, and nothing is ever
 * half-open — so a test of reconnection, of a lost acknowledgement, or of a
 * stalled path goes green while proving nothing at all. The faults are opt-in and
 * off by default.
 */
export interface MemoryFaults {
  /**
   * Accept sends and discard them, leaving `open` true.
   *
   * This is the failure that matters most and is the hardest to fake: a WebRTC
   * channel whose ICE path has died reports itself open, buffers whatever you
   * hand it, and tells nobody.
   */
  blackhole?: boolean;
  /** Deliver every payload twice, as a peer replaying after a reconnect would. */
  duplicate?: boolean;
  /** Hold delivery for this many microtask turns, so ordering can be perturbed. */
  delayTurns?: number;
  /** Report this many bytes as still queued locally. */
  bufferedAmount?: number;
}

class MemoryConnection implements TransportConnection {
  private readonly data = createEmitter<[unknown]>();
  private readonly closed = createEmitter<[]>();
  private readonly errors = createEmitter<[TransportError]>();
  private readonly unstable = createEmitter<[]>();
  private isOpen = true;
  peer: MemoryConnection | null = null;
  faults: MemoryFaults = {};

  constructor(readonly remoteId: string) {}

  get open(): boolean {
    return this.isOpen;
  }

  get bufferedAmount(): number {
    return this.faults.bufferedAmount ?? 0;
  }

  send(payload: unknown): void {
    if (!this.isOpen) {
      this.errors.emit(new TransportError('closed', 'Connection is closed'));
      return;
    }
    if (this.faults.blackhole === true) {
      return;
    }
    // Structured-clone semantics, like a real data channel.
    const cloned: unknown = JSON.parse(JSON.stringify(payload));
    const copies = this.faults.duplicate === true ? 2 : 1;
    const deliver = (): void => {
      for (let copy = 0; copy < copies; copy += 1) {
        if (this.peer?.isOpen) {
          this.peer.data.emit(cloned);
        }
      }
    };
    const turns = this.faults.delayTurns ?? 0;
    let queued = deliver;
    for (let turn = 0; turn < turns; turn += 1) {
      const next = queued;
      queued = () => queueMicrotask(next);
    }
    queueMicrotask(queued);
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
    return Promise.resolve({ bufferedAmount: this.bufferedAmount });
  }

  /** Test hook: reports degradation without closing, as a `disconnected` ICE state does. */
  degrade(): void {
    this.unstable.emit();
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.closed.emit();
    const other = this.peer;
    if (other?.isOpen) {
      queueMicrotask(() => other.closeFromRemote());
    }
  }

  /**
   * Test hook: drops this end silently, as a lost network does.
   *
   * The difference from `close()` is the whole point — the far end is never told,
   * so it keeps believing it has a live channel.
   */
  vanish(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.closed.emit();
  }

  closeFromRemote(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.closed.emit();
  }
}

class MemoryTransport implements Transport {
  readonly kind = 'memory' as const;
  private readonly incoming = createEmitter<[TransportConnection]>();
  private readonly errors = createEmitter<[TransportError]>();
  private readonly signalling = createEmitter<[SignallingState]>();
  private destroyed = false;
  /** When set, `connect()` behaves as the fault describes instead of succeeding. */
  private connectFault: 'hang' | 'unavailable' | 'signalling' | null = null;
  private signallingDown = false;
  /** Applied to every connection this transport creates from now on. */
  faults: MemoryFaults = {};

  constructor(
    readonly localId: string,
    private readonly network: MemoryNetwork,
  ) {}

  ready(): Promise<string> {
    return this.destroyed
      ? Promise.reject(new TransportError('closed', 'Transport destroyed'))
      : Promise.resolve(this.localId);
  }

  signallingReady(): Promise<void> {
    return this.signallingDown
      ? Promise.reject(new TransportError('signalingUnavailable', 'Signalling is down'))
      : Promise.resolve();
  }

  connect(remoteId: string): Promise<TransportConnection> {
    if (this.destroyed) {
      return Promise.reject(new TransportError('closed', 'Transport destroyed'));
    }
    if (this.connectFault === 'hang') {
      return new Promise<TransportConnection>(() => {
        /* never settles, like an offer nobody answers */
      });
    }
    if (this.connectFault === 'unavailable') {
      return Promise.reject(new TransportError('peerUnavailable', `No peer with id ${remoteId}`));
    }
    if (this.connectFault === 'signalling' || this.signallingDown) {
      return Promise.reject(new TransportError('signalingUnavailable', 'Signalling is down'));
    }
    const remote = this.network.get(remoteId);
    if (!remote || remote.destroyed) {
      return Promise.reject(new TransportError('peerUnavailable', `No peer with id ${remoteId}`));
    }
    const local = new MemoryConnection(remoteId);
    const other = new MemoryConnection(this.localId);
    local.peer = other;
    other.peer = local;
    local.faults = this.faults;
    other.faults = remote.faults;
    queueMicrotask(() => {
      remote.incoming.emit(other);
    });
    return Promise.resolve(local);
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

  /** Test hook: simulates a transport-level failure. */
  failWith(error: TransportError): void {
    this.errors.emit(error);
  }

  /** Test hook: makes the next connects fail in a specific, realistic way. */
  setConnectFault(fault: 'hang' | 'unavailable' | 'signalling' | null): void {
    this.connectFault = fault;
  }

  /** Test hook: takes signalling away without touching existing connections. */
  setSignalling(state: SignallingState): void {
    this.signallingDown = state === 'down';
    this.signalling.emit(state);
  }

  destroy(): void {
    this.destroyed = true;
    this.incoming.clear();
    this.errors.clear();
    this.signalling.clear();
    this.network.remove(this.localId);
  }
}

/** Registry that lets memory transports find each other by id. */
export class MemoryNetwork {
  private readonly transports = new Map<string, MemoryTransport>();

  create(id: string = `mem-${randomHex(4)}`): Transport {
    if (this.transports.has(id)) {
      throw new TransportError('idUnavailable', `Id ${id} already in use`);
    }
    const transport = new MemoryTransport(id, this);
    this.transports.set(id, transport);
    return transport;
  }

  get(id: string): MemoryTransport | undefined {
    return this.transports.get(id);
  }

  remove(id: string): void {
    this.transports.delete(id);
  }

  get size(): number {
    return this.transports.size;
  }
}

export type { MemoryConnection };
