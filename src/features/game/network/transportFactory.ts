import { createBroadcastTransport } from './broadcastTransport.ts';
import { createPeerTransport } from './peerTransport.ts';
import { TransportError, type Transport, type TransportKind } from './transport.ts';

/**
 * Chooses a transport. `peerjs` is the default; `?transport=broadcast` switches
 * to the same-browser BroadcastChannel transport used by end-to-end tests and
 * same-device play.
 */
export function readTransportKind(search: string = window.location.search): TransportKind {
  const requested = new URLSearchParams(search).get('transport');
  return requested === 'broadcast' ? 'broadcast' : 'peerjs';
}

export interface CreateTransportOptions {
  readonly kind?: TransportKind;
  /** Requested peer id — hosts derive it from the room code. */
  readonly id?: string;
}

export function createTransport(options: CreateTransportOptions = {}): Transport {
  const kind = options.kind ?? readTransportKind();
  switch (kind) {
    case 'broadcast':
      return createBroadcastTransport(options.id);
    case 'memory':
      throw new TransportError('unknown', 'The memory transport is only available in tests');
    case 'peerjs':
      return createPeerTransport(options.id ? { id: options.id } : {});
  }
}
