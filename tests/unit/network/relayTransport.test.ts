import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelayTransport } from '../../../src/features/game/network/relayTransport.ts';
import { RELAY_PROTOCOL_VERSION } from '../../../src/features/game/network/relayProtocol.ts';
import {
  TransportError,
  type Transport,
  type TransportConnection,
} from '../../../src/features/game/network/transport.ts';

/**
 * The transport under a WebSocket it fully controls.
 *
 * Every scenario here is one that killed a real game under WebRTC: the id that
 * cannot be claimed, the socket that dies mid-hand, the phone that wakes up
 * holding a connection the network tore down an hour ago. The fake socket makes
 * each of them reproducible.
 */

const HOST_ID = 'crush-482913';
const CLAIM = 'a'.repeat(32);

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('not open');
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  // ---- test controls ----

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverSend(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  serverDrop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Frames the client sent, parsed, of one type. */
  ofType(type: string): Record<string, unknown>[] {
    return this.sent
      .filter((raw) => raw !== 'ping')
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame['t'] === type);
  }
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) {
    throw new Error('no socket was opened');
  }
  return socket;
}

/** Welcomes the newest socket, completing hello → welcome. */
function welcome(peers: string[] = []): FakeWebSocket {
  const socket = lastSocket();
  socket.serverOpen();
  socket.serverSend({ t: 'welcome', peers });
  return socket;
}

const transports: Transport[] = [];

function makeHost(): Transport {
  const transport = createRelayTransport({ id: HOST_ID, claim: CLAIM });
  transports.push(transport);
  return transport;
}

function makeGuest(): Transport {
  const transport = createRelayTransport({});
  transports.push(transport);
  return transport;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  for (const transport of transports.splice(0)) {
    transport.destroy();
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('registration', () => {
  it('a host says hello with its id and claim, and is ready on the welcome', async () => {
    const transport = makeHost();
    const socket = lastSocket();
    expect(socket.url).toContain('/v1/room/482913');
    socket.serverOpen();
    expect(socket.ofType('hello')).toEqual([
      { t: 'hello', v: RELAY_PROTOCOL_VERSION, peerId: HOST_ID, claim: CLAIM },
    ]);
    socket.serverSend({ t: 'welcome', peers: [] });
    await expect(transport.ready()).resolves.toBe(HOST_ID);
  });

  it('a denied claim surfaces as idUnavailable and ends the retrying', async () => {
    const transport = makeHost();
    const socket = lastSocket();
    socket.serverOpen();
    socket.serverSend({ t: 'denied', reason: 'idTaken' });
    await expect(transport.ready()).rejects.toMatchObject({ code: 'idUnavailable' });
    // The socket the server will now close must not be replaced by a retry:
    // the same hello would be denied for ever.
    socket.serverDrop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a guest is ready immediately and only dials when told which room', async () => {
    const transport = makeGuest();
    await expect(transport.ready()).resolves.toMatch(/^p-/);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('an unparseable host id is refused outright', () => {
    expect(() => createRelayTransport({ id: 'not-a-room-id' })).toThrow(TransportError);
  });
});

describe('connecting to a peer', () => {
  it('derives the room from the host peer id and completes open → accept', async () => {
    const transport = makeGuest();
    const pending = transport.connect(HOST_ID, 5_000);
    welcome([HOST_ID]);
    const socket = lastSocket();
    await vi.advanceTimersByTimeAsync(0);
    const open = socket.ofType('open')[0];
    expect(open).toBeDefined();
    expect(open?.['to']).toBe(HOST_ID);
    socket.serverSend({ t: 'accept', from: HOST_ID, ch: open?.['ch'] });
    const connection = await pending;
    expect(connection.remoteId).toBe(HOST_ID);
    expect(connection.open).toBe(true);
  });

  it('rejects with peerUnavailable when the room says the host is not there', async () => {
    const transport = makeGuest();
    const pending = transport.connect(HOST_ID, 5_000);
    const socket = welcome();
    await vi.advanceTimersByTimeAsync(0);
    const open = socket.ofType('open')[0];
    socket.serverSend({ t: 'gone', peerId: HOST_ID, ch: open?.['ch'] });
    await expect(pending).rejects.toMatchObject({ code: 'peerUnavailable' });
  });

  it('rejects with timeout when nothing answers inside the budget', async () => {
    const transport = makeGuest();
    const pending = transport.connect(HOST_ID, 5_000).catch((error: TransportError) => error);
    welcome();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(((await pending) as TransportError).code).toBe('timeout');
  });
});

describe('carrying data', () => {
  async function connectedPair(): Promise<{
    guest: Transport;
    connection: TransportConnection;
    socket: FakeWebSocket;
    ch: string;
  }> {
    const guest = makeGuest();
    const pending = guest.connect(HOST_ID, 5_000);
    const socket = welcome([HOST_ID]);
    await vi.advanceTimersByTimeAsync(0);
    const ch = (socket.ofType('open')[0]?.['ch'] ?? '') as string;
    socket.serverSend({ t: 'accept', from: HOST_ID, ch });
    return { guest, connection: await pending, socket, ch };
  }

  it('sends msg frames and delivers replies on the right channel', async () => {
    const { connection, socket, ch } = await connectedPair();
    const received: unknown[] = [];
    connection.onData((payload) => received.push(payload));

    connection.send({ move: 'playCard' });
    expect(socket.ofType('msg')).toEqual([{ t: 'msg', to: HOST_ID, ch, d: { move: 'playCard' } }]);

    socket.serverSend({ t: 'msg', from: HOST_ID, ch, d: { state: 42 } });
    socket.serverSend({ t: 'msg', from: HOST_ID, ch: 'c-other', d: { state: 'wrong channel' } });
    expect(received).toEqual([{ state: 42 }]);
  });

  it('a remote close closes the connection', async () => {
    const { connection, socket, ch } = await connectedPair();
    const closed = vi.fn();
    connection.onClose(closed);
    socket.serverSend({ t: 'close', from: HOST_ID, ch });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(connection.open).toBe(false);
  });

  it('peerDown closes every channel to that peer', async () => {
    const { connection, socket } = await connectedPair();
    const closed = vi.fn();
    connection.onClose(closed);
    socket.serverSend({ t: 'peerDown', peerId: HOST_ID });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('answers an incoming open with accept and surfaces the connection once', async () => {
    const transport = makeHost();
    const incoming: TransportConnection[] = [];
    transport.onIncoming((connection) => incoming.push(connection));
    const socket = welcome();
    await transport.ready();

    socket.serverSend({ t: 'open', from: 'p-guest', ch: 'c-1' });
    // A duplicate open (our accept was lost) is re-accepted, not re-announced.
    socket.serverSend({ t: 'open', from: 'p-guest', ch: 'c-1' });

    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.remoteId).toBe('p-guest');
    expect(socket.ofType('accept')).toEqual([
      { t: 'accept', to: 'p-guest', ch: 'c-1' },
      { t: 'accept', to: 'p-guest', ch: 'c-1' },
    ]);
  });
});

describe('losing and regaining the relay', () => {
  it('a dropped socket closes every channel honestly and reconnects with backoff', async () => {
    const transport = makeHost();
    const socket = welcome();
    await transport.ready();
    const states: string[] = [];
    transport.onSignallingChange((state) => states.push(state));
    const closedSpy = vi.fn();
    transport.onIncoming((connection) => connection.onClose(closedSpy));
    socket.serverSend({ t: 'open', from: 'p-guest', ch: 'c-1' });

    socket.serverDrop();
    // The room forgot us the moment the socket died; pretending the channel is
    // still open would be the half-open limbo this transport exists to remove.
    expect(closedSpy).toHaveBeenCalledTimes(1);
    expect(states).toContain('down');

    // First backoff step is immediate; a fresh socket appears and re-hellos.
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const fresh = lastSocket();
    fresh.serverOpen();
    expect(fresh.ofType('hello')).toHaveLength(1);
    fresh.serverSend({ t: 'welcome', peers: [] });
    await transport.signallingReady(1_000);
    expect(states).toContain('up');
  });

  it('signallingReady waits for the welcome and honours its deadline', async () => {
    const transport = makeHost();
    welcome();
    await transport.ready();
    lastSocket().serverDrop();

    const pending = transport.signallingReady(2_000).catch((error: TransportError) => error);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(((await pending) as TransportError).code).toBe('signalingUnavailable');
  });

  it('convicts a half-open socket after unanswered pings and reopens', async () => {
    const transport = makeHost();
    const socket = welcome();
    await transport.ready();

    // The socket stays OPEN but nothing answers: the phone-woke-up case.
    // Two ping deadlines must pass (15s interval + 3s deadline, twice).
    await vi.advanceTimersByTimeAsync(2 * (15_000 + 3_000) + 1_000);

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('pongs keep the socket alive', async () => {
    const transport = makeHost();
    const socket = welcome();
    await transport.ready();

    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      if (socket.sent.includes('ping')) {
        socket.serverSend('pong');
      }
    }
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('teardown', () => {
  it('destroy closes the socket and every channel, and stops reconnecting', async () => {
    const transport = makeHost();
    const socket = welcome();
    await transport.ready();
    transport.destroy();
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await expect(transport.connect(HOST_ID)).rejects.toMatchObject({ code: 'closed' });
  });
});
