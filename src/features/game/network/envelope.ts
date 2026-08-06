import { createMessageId } from '../../../lib/id.ts';
import { PROTOCOL_VERSION, type ClientMessage, type RoomMessage } from './protocol.ts';

export interface MessageContext {
  readonly roomId: string;
  /**
   * Who is speaking, for the log.
   *
   * It used to be a routable peer id, and routing is what it was for: the relay
   * addressed frames by it. Nothing is routed any more — a client's only
   * correspondent is the room, and the room's only correspondents are the sockets
   * it holds — so this is now a connection label. Clients stamp a per-tab id; the
   * room stamps `'room'`.
   */
  readonly senderPeerId: string;
  /** Injectable clock so tests stay deterministic. */
  readonly now?: () => number;
}

function envelope(context: MessageContext): {
  protocolVersion: number;
  id: string;
  roomId: string;
  senderPeerId: string;
  timestamp: number;
} {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: createMessageId(),
    roomId: context.roomId,
    senderPeerId: context.senderPeerId,
    timestamp: (context.now ?? Date.now)(),
  };
}

/** Builds a fully-formed, schema-valid client message. */
export function clientMessage<TType extends ClientMessage['type']>(
  context: MessageContext,
  type: TType,
  payload: Extract<ClientMessage, { type: TType }>['payload'],
): Extract<ClientMessage, { type: TType }> {
  return { ...envelope(context), type, payload } as Extract<ClientMessage, { type: TType }>;
}

/** Builds a fully-formed, schema-valid room message. */
export function roomMessage<TType extends RoomMessage['type']>(
  context: MessageContext,
  type: TType,
  payload: Extract<RoomMessage, { type: TType }>['payload'],
): Extract<RoomMessage, { type: TType }> {
  return { ...envelope(context), type, payload } as Extract<RoomMessage, { type: TType }>;
}

/**
 * Bounded set of recently seen message ids.
 *
 * A WebSocket is reliable and ordered, so duplicates are rare — but a client
 * resends after a reconnect by design, and a buggy or hostile one can replay
 * deliberately. Dropping repeats keeps message handling idempotent.
 *
 * This is *not* what makes a move idempotent: an envelope id is minted fresh on
 * every send, so a deliberate re-send of the same intent has a new one. That is
 * `requestId`'s job, and it lives on the seat rather than the connection.
 */
export class MessageDeduplicator {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity = 512) {}

  /** Returns `true` the first time an id is seen, `false` for repeats. */
  accept(id: string): boolean {
    if (this.seen.has(id)) {
      return false;
    }
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) {
        this.seen.delete(evicted);
      }
    }
    return true;
  }

  reset(): void {
    this.seen.clear();
    this.order.length = 0;
  }

  get size(): number {
    return this.seen.size;
  }
}
