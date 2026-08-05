import { createBroadcastTransport } from './broadcastTransport.ts';
import { createRelayTransport } from './relayTransport.ts';
import { TransportError, type Transport, type TransportKind } from './transport.ts';

/**
 * Chooses a transport. `relay` is the default; `?transport=broadcast` switches
 * to the same-browser BroadcastChannel transport used by end-to-end tests and
 * same-device play.
 */
export function readTransportKind(search: string = window.location.search): TransportKind {
  const requested = new URLSearchParams(search).get('transport');
  return requested === 'broadcast' ? 'broadcast' : 'relay';
}

export interface CreateTransportOptions {
  readonly kind?: TransportKind;
  /** Requested peer id — hosts derive it from the room code. */
  readonly id?: string;
  /** Proof of ownership for `id`; presenting it again later reclaims the id. */
  readonly claim?: string;
}

export function createTransport(options: CreateTransportOptions = {}): Transport {
  const kind = options.kind ?? readTransportKind();
  switch (kind) {
    case 'broadcast':
      return createBroadcastTransport(options.id);
    case 'memory':
      throw new TransportError('unknown', 'The memory transport is only available in tests');
    case 'relay':
      return createRelayTransport({
        ...(options.id ? { id: options.id } : {}),
        ...(options.claim ? { claim: options.claim } : {}),
      });
  }
}
