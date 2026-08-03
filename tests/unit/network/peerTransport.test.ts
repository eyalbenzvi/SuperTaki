import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests the PeerJS wrapper against a fake `Peer`, so the initialisation
 * contract is pinned without touching a real signalling server.
 */
type Handler = (...args: unknown[]) => void;

class FakePeer {
  static instances: FakePeer[] = [];
  readonly handlers = new Map<string, Handler[]>();
  destroyed = false;

  constructor(...args: unknown[]) {
    this.requestedId = typeof args[0] === 'string' ? args[0] : null;
    FakePeer.instances.push(this);
  }

  readonly requestedId: string | null;

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

  reconnect(): void {}

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
