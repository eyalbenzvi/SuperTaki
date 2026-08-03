import { MemoryNetwork } from '../../../src/features/game/network/memoryTransport.ts';
import { PROTOCOL_VERSION } from '../../../src/features/game/network/protocol.ts';
import type { SessionUpdate } from '../../../src/features/game/network/session.ts';
import type { Transport, TransportConnection } from '../../../src/features/game/network/transport.ts';

export const TEST_ROOM = 'TIGER-MANGO-42';

/** Lets queued microtasks and timer callbacks drain. */
export async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** Collects session updates and offers convenient lookups. */
export function createRecorder(): {
  observer: (update: SessionUpdate) => void;
  updates: SessionUpdate[];
  ofType: <TType extends SessionUpdate['type']>(type: TType) => Extract<SessionUpdate, { type: TType }>[];
  last: <TType extends SessionUpdate['type']>(
    type: TType,
  ) => Extract<SessionUpdate, { type: TType }> | undefined;
  clear: () => void;
} {
  const updates: SessionUpdate[] = [];
  const ofType = <TType extends SessionUpdate['type']>(
    type: TType,
  ): Extract<SessionUpdate, { type: TType }>[] =>
    updates.filter((update): update is Extract<SessionUpdate, { type: TType }> => update.type === type);

  return {
    observer: (update) => {
      updates.push(update);
    },
    updates,
    ofType,
    last: (type) => ofType(type).at(-1),
    clear: () => {
      updates.length = 0;
    },
  };
}

/**
 * A peer that speaks the wire protocol by hand, used to test how a session
 * reacts to malformed, replayed or hostile traffic.
 */
export interface ScriptedPeer {
  readonly transport: Transport;
  readonly received: unknown[];
  connectTo(remoteId: string): Promise<TransportConnection>;
  send(payload: unknown): void;
  ofType(type: string): Array<Record<string, unknown>>;
  envelope(type: string, payload: unknown, overrides?: Record<string, unknown>): Record<string, unknown>;
  close(): void;
}

export function createScriptedPeer(network: MemoryNetwork, id: string): ScriptedPeer {
  const transport = network.create(id);
  const received: unknown[] = [];
  let connection: TransportConnection | null = null;

  const attach = (candidate: TransportConnection): void => {
    connection = candidate;
    candidate.onData((payload) => {
      received.push(payload);
    });
  };

  transport.onIncoming(attach);

  let counter = 0;
  return {
    transport,
    received,
    async connectTo(remoteId) {
      const candidate = await transport.connect(remoteId);
      attach(candidate);
      return candidate;
    },
    send(payload) {
      connection?.send(payload);
    },
    ofType(type) {
      return received.filter(
        (message): message is Record<string, unknown> =>
          typeof message === 'object' && message !== null && (message as { type?: string }).type === type,
      );
    },
    envelope(type, payload, overrides = {}) {
      counter += 1;
      return {
        protocolVersion: PROTOCOL_VERSION,
        id: `scripted-${id}-${counter}`,
        roomId: TEST_ROOM,
        senderPeerId: id,
        timestamp: 1_700_000_000_000,
        type,
        payload,
        ...overrides,
      };
    },
    close() {
      connection?.close();
      transport.destroy();
    },
  };
}

export { MemoryNetwork };
