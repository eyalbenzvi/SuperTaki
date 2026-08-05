import { describe, expect, it } from 'vitest';
import { CLAIM_HOLD_MS, MAX_FRAME_BYTES, parseClientFrame } from '../src/protocol.ts';
import {
  CLOSE_BAD_FRAME,
  CLOSE_DENIED,
  CLOSE_SUPERSEDED,
  RoomCore,
  type ClaimRecord,
  type ClaimStore,
  type PeerSocket,
} from '../src/roomCore.ts';

class FakeSocket implements PeerSocket {
  readonly sent: unknown[] = [];
  closedWith: { code: number; reason: string } | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  /** Frames of one type, for assertions that ignore unrelated chatter. */
  ofType(type: string): Record<string, unknown>[] {
    return this.sent.filter((f): f is Record<string, unknown> => (f as { t?: string }).t === type);
  }

  last(): Record<string, unknown> {
    return this.sent[this.sent.length - 1] as Record<string, unknown>;
  }
}

class MemoryStore implements ClaimStore {
  private readonly records = new Map<string, ClaimRecord>();

  get(peerId: string): ClaimRecord | undefined {
    return this.records.get(peerId);
  }

  put(peerId: string, record: ClaimRecord): void {
    this.records.set(peerId, record);
  }
}

const HOST_CLAIM = 'a'.repeat(32);
const OTHER_CLAIM = 'b'.repeat(32);

function hello(peerId: string, claim: string): string {
  return JSON.stringify({ t: 'hello', v: 1, peerId, claim });
}

function setup(now = { value: 1_000_000 }) {
  const store = new MemoryStore();
  const core = new RoomCore(store, () => now.value);
  return { core, store, now };
}

function join(core: RoomCore, peerId: string, claim: string): FakeSocket {
  const socket = new FakeSocket();
  core.handleMessage(socket, hello(peerId, claim));
  return socket;
}

describe('hello and identity', () => {
  it('welcomes a first peer with an empty room', () => {
    const { core } = setup();
    const socket = join(core, 'crush-123456', HOST_CLAIM);
    expect(socket.last()).toEqual({ t: 'welcome', peers: [] });
    expect(socket.closedWith).toBeNull();
  });

  it('lists existing peers in the welcome and announces the arrival to them', () => {
    const { core } = setup();
    const host = join(core, 'crush-123456', HOST_CLAIM);
    const guest = join(core, 'guest-1', OTHER_CLAIM);
    expect(guest.last()).toEqual({ t: 'welcome', peers: ['crush-123456'] });
    expect(host.ofType('peerUp')).toEqual([{ t: 'peerUp', peerId: 'guest-1' }]);
  });

  it('denies a peer id owned by a different claim while its socket is live', () => {
    const { core } = setup();
    join(core, 'crush-123456', HOST_CLAIM);
    const intruder = join(core, 'crush-123456', OTHER_CLAIM);
    expect(intruder.ofType('denied')).toEqual([{ t: 'denied', reason: 'idTaken' }]);
    expect(intruder.closedWith?.code).toBe(CLOSE_DENIED);
  });

  it('keeps the id held for the claim hold after the socket dies', () => {
    const { core, now } = setup();
    const host = join(core, 'crush-123456', HOST_CLAIM);
    core.handleClose(host);
    now.value += CLAIM_HOLD_MS - 1;
    const intruder = join(core, 'crush-123456', OTHER_CLAIM);
    expect(intruder.ofType('denied')).toEqual([{ t: 'denied', reason: 'idTaken' }]);
  });

  it('releases the id to a new claim once the hold expires', () => {
    const { core, now } = setup();
    const host = join(core, 'crush-123456', HOST_CLAIM);
    core.handleClose(host);
    now.value += CLAIM_HOLD_MS + 1;
    const newcomer = join(core, 'crush-123456', OTHER_CLAIM);
    expect(newcomer.last()).toEqual({ t: 'welcome', peers: [] });
  });

  it('lets the same claim reclaim its id at any time - the host recovery path', () => {
    const { core, now } = setup();
    const host = join(core, 'crush-123456', HOST_CLAIM);
    core.handleClose(host);
    now.value += CLAIM_HOLD_MS * 10;
    const returning = join(core, 'crush-123456', HOST_CLAIM);
    expect(returning.last()).toEqual({ t: 'welcome', peers: [] });
  });

  it('supersedes the old socket when the same claim reconnects while it is still open', () => {
    const { core } = setup();
    const stale = join(core, 'crush-123456', HOST_CLAIM);
    const fresh = join(core, 'crush-123456', HOST_CLAIM);
    expect(stale.closedWith?.code).toBe(CLOSE_SUPERSEDED);
    expect(fresh.last()).toEqual({ t: 'welcome', peers: [] });
  });

  it('does not announce a departure when a superseded socket finally closes', () => {
    const { core } = setup();
    const guestSocket = join(core, 'guest-1', OTHER_CLAIM);
    const superseded = join(core, 'crush-123456', HOST_CLAIM);
    join(core, 'crush-123456', HOST_CLAIM); // a fresh socket takes the name over
    core.handleClose(superseded);
    // guest-1 saw the original arrival; it must not now see a peerDown for a
    // host that is still connected on the fresh socket.
    expect(guestSocket.ofType('peerDown')).toEqual([]);
  });

  it('rejects an unsupported protocol version explicitly', () => {
    const { core } = setup();
    const socket = new FakeSocket();
    core.handleMessage(socket, JSON.stringify({ t: 'hello', v: 99, peerId: 'x', claim: HOST_CLAIM }));
    expect(socket.ofType('denied')).toEqual([{ t: 'denied', reason: 'protocolVersion' }]);
  });
});

describe('routing', () => {
  it('routes a frame and stamps from with the authenticated identity', () => {
    const { core } = setup();
    const host = join(core, 'crush-123456', HOST_CLAIM);
    const guest = join(core, 'guest-1', OTHER_CLAIM);
    core.handleMessage(guest, JSON.stringify({ t: 'open', to: 'crush-123456', ch: 'c1', d: { hi: true } }));
    expect(host.ofType('open')).toEqual([{ t: 'open', from: 'guest-1', ch: 'c1', d: { hi: true } }]);
  });

  it('a client cannot forge the from field', () => {
    const { core } = setup();
    const host = join(core, 'crush-123456', HOST_CLAIM);
    const guest = join(core, 'guest-1', OTHER_CLAIM);
    core.handleMessage(
      guest,
      JSON.stringify({ t: 'msg', to: 'crush-123456', ch: 'c1', from: 'somebody-else', d: 1 }),
    );
    expect(host.ofType('msg')).toEqual([{ t: 'msg', from: 'guest-1', ch: 'c1', d: 1 }]);
  });

  it('answers gone when the target is not in the room', () => {
    const { core } = setup();
    const guest = join(core, 'guest-1', OTHER_CLAIM);
    core.handleMessage(guest, JSON.stringify({ t: 'open', to: 'crush-999999', ch: 'c1' }));
    expect(guest.ofType('gone')).toEqual([{ t: 'gone', peerId: 'crush-999999', ch: 'c1' }]);
  });

  it('closes a socket that routes before saying hello', () => {
    const { core } = setup();
    const socket = new FakeSocket();
    core.handleMessage(socket, JSON.stringify({ t: 'msg', to: 'crush-123456', ch: 'c1', d: 1 }));
    expect(socket.closedWith?.code).toBe(CLOSE_BAD_FRAME);
  });

  it('closes a socket on a malformed frame', () => {
    const { core } = setup();
    const socket = join(core, 'guest-1', OTHER_CLAIM);
    core.handleMessage(socket, 'not json at all');
    expect(socket.closedWith?.code).toBe(CLOSE_BAD_FRAME);
  });

  it('announces a departure to everybody else', () => {
    const { core } = setup();
    const host = join(core, 'crush-123456', HOST_CLAIM);
    const guest = join(core, 'guest-1', OTHER_CLAIM);
    core.handleClose(guest);
    expect(host.ofType('peerDown')).toEqual([{ t: 'peerDown', peerId: 'guest-1' }]);
  });
});

describe('frame parsing limits', () => {
  it('rejects oversized frames', () => {
    const big = JSON.stringify({ t: 'msg', to: 'a', ch: 'c', d: 'x'.repeat(MAX_FRAME_BYTES) });
    expect(parseClientFrame(big)).toBeNull();
  });

  it('rejects invalid peer ids and channels', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'msg', to: 'bad id!', ch: 'c1' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'msg', to: 'ok-id', ch: 'bad ch!' }))).toBeNull();
    expect(
      parseClientFrame(JSON.stringify({ t: 'hello', v: 1, peerId: 'ok', claim: 'TOO SHORT' })),
    ).toBeNull();
  });
});
