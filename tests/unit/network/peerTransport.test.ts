import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests the PeerJS wrapper against a fake `Peer`, so the initialisation
 * contract is pinned without touching a real signalling server.
 */
type Handler = (...args: unknown[]) => void;

class FakeDataConnection {
  readonly handlers = new Map<string, Handler[]>();
  open = false;
  closed = false;

  constructor(readonly peer: string) {}

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  once(event: string, handler: Handler): this {
    return this.on(event, handler);
  }

  off(): this {
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  close(): void {
    this.closed = true;
  }
}

class FakePeer {
  static instances: FakePeer[] = [];
  readonly handlers = new Map<string, Handler[]>();
  destroyed = false;
  /** Mirrors PeerJS: true once the broker socket is gone. */
  disconnected = false;
  reconnectCalls = 0;
  readonly options: Record<string, unknown>;
  readonly connections: FakeDataConnection[] = [];

  constructor(...args: unknown[]) {
    this.requestedId = typeof args[0] === 'string' ? args[0] : null;
    const options = typeof args[0] === 'string' ? args[1] : args[0];
    this.options = (options as Record<string, unknown>) ?? {};
    FakePeer.instances.push(this);
  }

  readonly requestedId: string | null;

  /**
   * PeerJS returns `undefined` here whenever the peer is disconnected from the
   * broker — the behaviour that used to crash every reconnect attempt.
   */
  connect(peer: string): FakeDataConnection | undefined {
    if (this.disconnected) {
      return undefined;
    }
    const connection = new FakeDataConnection(peer);
    this.connections.push(connection);
    return connection;
  }

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  once(event: string, handler: Handler): this {
    return this.on(event, handler);
  }

  off(): this {
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  reconnect(): void {
    this.reconnectCalls += 1;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

vi.mock('peerjs', () => ({ default: FakePeer }));

const { createPeerTransport } = await import('../../../src/features/game/network/peerTransport.ts');

beforeEach(() => {
  FakePeer.instances = [];
  // jsdom has no WebRTC; the transport probes for it before constructing a peer.
  Object.defineProperty(window, 'RTCPeerConnection', {
    value: function RTCPeerConnectionStub() {},
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Lets the awaits inside `connect()` — ready, then signalling — drain. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await Promise.resolve();
  }
}

function latestPeer(): FakePeer {
  const peer = FakePeer.instances.at(-1);
  if (!peer) {
    throw new Error('no peer was constructed');
  }
  return peer;
}

describe('peer initialisation', () => {
  it('resolves with the assigned id when signalling opens', async () => {
    const transport = createPeerTransport({ id: 'crush-tiger-mango-42' });
    expect(latestPeer().requestedId).toBe('crush-tiger-mango-42');

    latestPeer().emit('open', 'crush-tiger-mango-42');
    await expect(transport.ready()).resolves.toBe('crush-tiger-mango-42');
    expect(transport.localId).toBe('crush-tiger-mango-42');
  });

  it('gives up when signalling accepts the socket but never opens', async () => {
    // The free public broker does this: no `open`, no `error`, just silence.
    // Without a deadline the caller waits for ever and "Create room" spins with
    // no room code and no explanation.
    const transport = createPeerTransport({ id: 'crush-tiger-mango-42', readyTimeoutMs: 20 });

    await expect(transport.ready()).rejects.toMatchObject({
      name: 'TransportError',
      code: 'signalingUnavailable',
    });
    expect(transport.localId).toBeNull();
  });

  it('does not time out after a successful open', async () => {
    const transport = createPeerTransport({ id: 'crush-tiger-mango-42', readyTimeoutMs: 20 });
    latestPeer().emit('open', 'crush-tiger-mango-42');
    await expect(transport.ready()).resolves.toBe('crush-tiger-mango-42');

    await new Promise((resolve) => setTimeout(resolve, 40));
    // Still resolved, not rejected, well past the deadline.
    await expect(transport.ready()).resolves.toBe('crush-tiger-mango-42');
  });

  it.each([
    ['unavailable-id', 'idUnavailable'],
    ['browser-incompatible', 'browserUnsupported'],
    ['network', 'signalingUnavailable'],
    ['server-error', 'signalingUnavailable'],
    ['socket-error', 'signalingUnavailable'],
    ['webrtc', 'network'],
    ['something-new', 'unknown'],
  ])('maps a %s error to %s', async (peerType, expected) => {
    const transport = createPeerTransport({ id: 'crush-x-y-01', readyTimeoutMs: 500 });
    const error = Object.assign(new Error('boom'), { type: peerType });
    latestPeer().emit('error', error);

    await expect(transport.ready()).rejects.toMatchObject({ code: expected });
  });

  it('ignores a late error once an id has been assigned', async () => {
    const transport = createPeerTransport({ readyTimeoutMs: 500 });
    latestPeer().emit('open', 'random-id');
    await expect(transport.ready()).resolves.toBe('random-id');

    const seen: string[] = [];
    transport.onError((error) => {
      seen.push(error.code);
    });
    latestPeer().emit('error', Object.assign(new Error('later'), { type: 'network' }));

    // Surfaced to listeners, but `ready()` stays resolved.
    expect(seen).toEqual(['signalingUnavailable']);
    await expect(transport.ready()).resolves.toBe('random-id');
  });

  it('destroys the underlying peer', () => {
    const transport = createPeerTransport({ id: 'crush-x-y-01' });
    transport.destroy();
    expect(latestPeer().destroyed).toBe(true);
  });

  it('refuses to start without WebRTC support', () => {
    Object.defineProperty(window, 'RTCPeerConnection', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(() => createPeerTransport({})).toThrow(/does not support WebRTC/i);
  });
});

describe('ice configuration', () => {
  /*
   * The regression this pins: passing `config` to PeerJS *replaces* its
   * `DEFAULT_CONFIG`, and that default is where the only free TURN relays this
   * project has ever had access to live. Dropping them turned "some networks
   * cannot connect" from a bug into a documented limitation.
   */
  it('offers relay candidates, not only STUN', () => {
    createPeerTransport({ id: 'crush-x-y-01' });
    const config = latestPeer().options.config as RTCConfiguration;
    const urls = (config.iceServers ?? []).flatMap((server) =>
      Array.isArray(server.urls) ? server.urls : [server.urls],
    );

    expect(urls.some((url) => url.startsWith('stun:'))).toBe(true);
    expect(urls).toContain('turn:eu-0.turn.peerjs.com:3478');
    expect(urls).toContain('turn:us-0.turn.peerjs.com:3478');
  });

  it('leaves the transport policy alone, so a direct path still wins', () => {
    createPeerTransport({ id: 'crush-x-y-01' });
    const config = latestPeer().options.config as RTCConfiguration;
    // Relay is a fallback, never a default: forcing it would spend donated
    // bandwidth on pairs that can reach each other directly.
    expect(config.iceTransportPolicy).toBeUndefined();
  });
});

describe('connecting while signalling is down', () => {
  it('reports signalling as the cause instead of crashing', async () => {
    const transport = createPeerTransport({ id: 'crush-x-y-01', readyTimeoutMs: 500 });
    const peer = latestPeer();
    peer.emit('open', 'crush-x-y-01');
    await transport.ready();

    peer.disconnected = true;
    peer.emit('disconnected');

    // `peer.connect()` returns undefined here. Dereferencing it used to throw a
    // TypeError inside the promise executor, which surfaced as a bogus
    // "unknown" error and told the player nothing.
    await expect(transport.connect('crush-a-b-02', 30)).rejects.toMatchObject({
      name: 'TransportError',
      code: 'signalingUnavailable',
    });
  });

  it('waits for signalling to come back before offering', async () => {
    const transport = createPeerTransport({ id: 'crush-x-y-01', readyTimeoutMs: 500 });
    const peer = latestPeer();
    peer.emit('open', 'crush-x-y-01');
    await transport.ready();

    peer.disconnected = true;
    peer.emit('disconnected');

    const pending = transport.connect('crush-a-b-02', 5_000);
    peer.disconnected = false;
    peer.emit('open', 'crush-x-y-01');

    await settle();
    const connection = peer.connections.at(-1);
    expect(connection?.peer).toBe('crush-a-b-02');
    connection?.emit('open');
    await expect(pending).resolves.toMatchObject({ remoteId: 'crush-a-b-02' });
  });

  it('closes the half-open connection when the offer fails', async () => {
    const transport = createPeerTransport({ id: 'crush-x-y-01', readyTimeoutMs: 500 });
    const peer = latestPeer();
    peer.emit('open', 'crush-x-y-01');
    await transport.ready();

    const pending = transport.connect('crush-a-b-02', 5_000);
    await settle();
    const connection = peer.connections.at(-1);
    connection?.emit('error', Object.assign(new Error('nope'), { type: 'peer-unavailable' }));

    await expect(pending).rejects.toMatchObject({ code: 'peerUnavailable' });
    // Each leak would otherwise be a live RTCPeerConnection still holding STUN
    // and TURN allocations, and an indefinite retry loop makes dozens.
    expect(connection?.closed).toBe(true);
  });

  it('signals the difference between losing the broker and losing a peer', async () => {
    const transport = createPeerTransport({ id: 'crush-x-y-01', readyTimeoutMs: 500 });
    const peer = latestPeer();
    peer.emit('open', 'crush-x-y-01');
    await transport.ready();

    const states: string[] = [];
    transport.onSignallingChange((state) => {
      states.push(state);
    });

    peer.disconnected = true;
    peer.emit('disconnected');
    peer.disconnected = false;
    peer.emit('open', 'crush-x-y-01');

    expect(states).toEqual(['down', 'up']);
  });
});

describe('re-registering with the broker', () => {
  it('backs off instead of spinning', async () => {
    vi.useFakeTimers();
    try {
      const transport = createPeerTransport({ id: 'crush-x-y-01', readyTimeoutMs: 500 });
      const peer = latestPeer();
      peer.emit('open', 'crush-x-y-01');
      peer.disconnected = true;

      // Five `disconnected` events in a row must not become five sockets: the
      // old handler reconnected unconditionally and immediately, and PeerJS
      // re-emits `disconnected` when the remembered id has been taken.
      for (let i = 0; i < 5; i += 1) {
        peer.emit('disconnected');
      }
      expect(peer.reconnectCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(50);
      expect(peer.reconnectCalls).toBe(1);
      transport.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops trying once the id has been taken', async () => {
    vi.useFakeTimers();
    try {
      const transport = createPeerTransport({ id: 'crush-x-y-01', readyTimeoutMs: 500 });
      const peer = latestPeer();
      peer.emit('open', 'crush-x-y-01');
      peer.disconnected = true;

      peer.emit('error', Object.assign(new Error('taken'), { type: 'unavailable-id' }));
      peer.emit('disconnected');
      await vi.advanceTimersByTimeAsync(5_000);

      // Retrying a taken id is the infinite-loop case: the server answers
      // ID-TAKEN, PeerJS disconnects rather than destroys, and the disconnect
      // handler tries again.
      expect(peer.reconnectCalls).toBe(0);
      transport.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
