import { randomHex } from '../../../lib/id.ts';
import { TransportError, createEmitter, type Transport, type TransportConnection } from './transport.ts';

/**
 * In-process transport used by tests: no timers, no browser APIs, delivery on a
 * microtask so ordering matches a real data channel closely enough.
 */
class MemoryConnection implements TransportConnection {
  private readonly data = createEmitter<[unknown]>();
  private readonly closed = createEmitter<[]>();
  private readonly errors = createEmitter<[TransportError]>();
  private isOpen = true;
  peer: MemoryConnection | null = null;

  constructor(readonly remoteId: string) {}

  get open(): boolean {
    return this.isOpen;
  }

  send(payload: unknown): void {
    if (!this.isOpen) {
      this.errors.emit(new TransportError('closed', 'Connection is closed'));
      return;
    }
    // Structured-clone semantics, like a real data channel.
    const cloned: unknown = JSON.parse(JSON.stringify(payload));
    queueMicrotask(() => {
      if (this.peer?.isOpen) {
        this.peer.data.emit(cloned);
      }
    });
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
  private destroyed = false;

  constructor(
    readonly localId: string,
    private readonly network: MemoryNetwork,
  ) {}

  ready(): Promise<string> {
    return this.destroyed
      ? Promise.reject(new TransportError('closed', 'Transport destroyed'))
      : Promise.resolve(this.localId);
  }

  connect(remoteId: string): Promise<TransportConnection> {
    if (this.destroyed) {
      return Promise.reject(new TransportError('closed', 'Transport destroyed'));
    }
    const remote = this.network.get(remoteId);
    if (!remote || remote.destroyed) {
      return Promise.reject(new TransportError('peerUnavailable', `No peer with id ${remoteId}`));
    }
    const local = new MemoryConnection(remoteId);
    const other = new MemoryConnection(this.localId);
    local.peer = other;
    other.peer = local;
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

  /** Test hook: simulates a transport-level failure. */
  failWith(error: TransportError): void {
    this.errors.emit(error);
  }

  destroy(): void {
    this.destroyed = true;
    this.incoming.clear();
    this.errors.clear();
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
