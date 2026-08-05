/**
 * The room's whole brain, with the platform held at arm's length.
 *
 * Everything the relay decides — who may hold a peer id, what gets forwarded
 * where, who is told about arrivals and departures — happens here against two
 * tiny interfaces: a socket that can `send` and `close`, and a key-value store
 * for claims. The Durable Object in `room.ts` is a thin adapter, which is what
 * lets this logic be unit-tested in plain Node without workerd.
 */

import {
  CLAIM_HOLD_MS,
  RELAY_PROTOCOL_VERSION,
  parseClientFrame,
  type DeniedReason,
  type ServerFrame,
} from './protocol.ts';

/** What the core needs from a WebSocket. */
export interface PeerSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** Persisted per peer id: who owns it, and when it was last alive. */
export interface ClaimRecord {
  readonly claim: string;
  readonly lastSeen: number;
}

/** What the core needs from durable storage. */
export interface ClaimStore {
  get(peerId: string): ClaimRecord | undefined;
  put(peerId: string, record: ClaimRecord): void;
}

/** Close codes surfaced to clients; 4xxx is the app-reserved range. */
export const CLOSE_BAD_FRAME = 4000;
/** A newer socket presented the same id and claim; this one is obsolete. */
export const CLOSE_SUPERSEDED = 4001;
export const CLOSE_DENIED = 4003;

interface LivePeer {
  readonly peerId: string;
  readonly socket: PeerSocket;
}

function frame(message: ServerFrame): string {
  return JSON.stringify(message);
}

export class RoomCore {
  /** peerId → live socket, at most one per id. */
  private readonly peers = new Map<string, LivePeer>();
  /** socket → peerId for sockets that have completed a hello. */
  private readonly identities = new Map<PeerSocket, string>();

  constructor(
    private readonly store: ClaimStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Live peer ids, for presence and for the DO's emptiness checks. */
  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  /** Re-attaches a socket that survived hibernation, from its saved identity. */
  restore(socket: PeerSocket, peerId: string): void {
    this.peers.set(peerId, { peerId, socket });
    this.identities.set(socket, peerId);
  }

  /**
   * Handles one inbound text frame. Returns `false` when the socket was closed
   * and the caller should stop tracking it.
   */
  handleMessage(socket: PeerSocket, raw: string): boolean {
    const parsed = parseClientFrame(raw);
    if (parsed === null) {
      socket.close(CLOSE_BAD_FRAME, 'malformed frame');
      this.forget(socket);
      return false;
    }

    if (parsed.t === 'hello') {
      return this.handleHello(socket, parsed.peerId, parsed.claim, parsed.v);
    }

    const fromId = this.identities.get(socket);
    if (fromId === undefined) {
      // Routing before a hello: the peer has no name to speak in.
      socket.close(CLOSE_BAD_FRAME, 'hello required first');
      return false;
    }

    const target = this.peers.get(parsed.to);
    if (target === undefined) {
      socket.send(frame({ t: 'gone', peerId: parsed.to, ch: parsed.ch }));
      return true;
    }
    // `from` is stamped here, from the socket's authenticated identity — never
    // copied from the client's frame.
    target.socket.send(
      frame({ t: parsed.t, from: fromId, ch: parsed.ch, ...('d' in parsed ? { d: parsed.d } : {}) }),
    );
    return true;
  }

  private deny(socket: PeerSocket, reason: DeniedReason): false {
    socket.send(frame({ t: 'denied', reason }));
    socket.close(CLOSE_DENIED, reason);
    this.forget(socket);
    return false;
  }

  private handleHello(socket: PeerSocket, peerId: string, claim: string, version: number): boolean {
    if (version !== RELAY_PROTOCOL_VERSION) {
      return this.deny(socket, 'protocolVersion');
    }
    if (peerId.length === 0 || claim.length === 0) {
      return this.deny(socket, 'badHello');
    }

    const existing = this.peers.get(peerId);
    const record = this.store.get(peerId);

    if (record !== undefined && record.claim !== claim) {
      /*
       * Someone else owns this id. While its socket is live, or recently was,
       * the id is simply taken — this is what turns a room-code collision into
       * an honest error the host can react to by drawing a new code. After the
       * hold expires the id is up for grabs again: the claim's purpose is to
       * protect a *returning* player's seat, not to reserve numbers forever.
       */
      const held = existing !== undefined || this.now() - record.lastSeen < CLAIM_HOLD_MS;
      if (held) {
        return this.deny(socket, 'idTaken');
      }
    }

    if (existing !== undefined && record !== undefined && record.claim === claim) {
      /*
       * The same identity on a fresh socket: a reload or a network handover
       * where the old TCP connection has not died yet. The new socket wins —
       * it is the one with a person behind it.
       */
      existing.socket.close(CLOSE_SUPERSEDED, 'superseded by a newer connection');
      this.identities.delete(existing.socket);
      this.peers.delete(peerId);
    }

    this.store.put(peerId, { claim, lastSeen: this.now() });
    this.peers.set(peerId, { peerId, socket });
    this.identities.set(socket, peerId);

    socket.send(frame({ t: 'welcome', peers: this.peerIds().filter((id) => id !== peerId) }));
    this.broadcast({ t: 'peerUp', peerId }, peerId);
    return true;
  }

  /** The authenticated peer id behind a socket, once its hello has been accepted. */
  identityOf(socket: PeerSocket): string | undefined {
    return this.identities.get(socket);
  }

  /** A socket died or was closed by the client. */
  handleClose(socket: PeerSocket): void {
    const peerId = this.identities.get(socket);
    this.forget(socket);
    if (peerId === undefined) {
      return;
    }
    const current = this.peers.get(peerId);
    if (current === undefined || current.socket !== socket) {
      // A superseding socket already took the name over; nothing has left.
      return;
    }
    this.peers.delete(peerId);
    const record = this.store.get(peerId);
    if (record !== undefined) {
      this.store.put(peerId, { claim: record.claim, lastSeen: this.now() });
    }
    this.broadcast({ t: 'peerDown', peerId }, peerId);
  }

  private forget(socket: PeerSocket): void {
    this.identities.delete(socket);
  }

  private broadcast(message: ServerFrame, exceptPeerId: string): void {
    const raw = frame(message);
    for (const peer of this.peers.values()) {
      if (peer.peerId !== exceptPeerId) {
        peer.socket.send(raw);
      }
    }
  }
}
