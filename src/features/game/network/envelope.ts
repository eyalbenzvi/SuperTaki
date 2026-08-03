import { createMessageId } from '../../../lib/id.ts';
import { PROTOCOL_VERSION, type ClientMessage, type HostMessage } from './protocol.ts';

export interface MessageContext {
  readonly roomId: string;
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

/** Builds a fully-formed, schema-valid host message. */
export function hostMessage<TType extends HostMessage['type']>(
  context: MessageContext,
  type: TType,
  payload: Extract<HostMessage, { type: TType }>['payload'],
): Extract<HostMessage, { type: TType }> {
  return { ...envelope(context), type, payload } as Extract<HostMessage, { type: TType }>;
}

/**
 * Bounded set of recently seen message ids.
 *
 * WebRTC data channels are reliable and ordered by default, so duplicates are
 * rare — but a peer can resend after a reconnect, and a buggy or hostile peer
 * can replay deliberately. Dropping repeats keeps command handling idempotent.
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
