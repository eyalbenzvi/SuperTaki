import { describe, expect, it } from 'vitest';
import {
  MessageDeduplicator,
  clientMessage,
  hostMessage,
} from '../../../src/features/game/network/envelope.ts';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  parseHostMessage,
} from '../../../src/features/game/network/protocol.ts';

const context = {
  roomId: 'TIGER-MANGO-42',
  senderPeerId: 'crush-tiger-mango-42',
  now: () => 1_700_000_000_000,
};

describe('envelope builders', () => {
  it('produces schema-valid client messages', () => {
    const message = clientMessage(context, 'joinRequest', { displayName: 'Dana' });
    expect(message.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(message.timestamp).toBe(1_700_000_000_000);
    expect(parseClientMessage(message).ok).toBe(true);
  });

  it('produces schema-valid host messages', () => {
    const message = hostMessage(context, 'ping', { nonce: 'abcd' });
    expect(parseHostMessage(message).ok).toBe(true);
  });

  it('gives every message a distinct id', () => {
    const ids = new Set(Array.from({ length: 200 }, () => clientMessage(context, 'leave', {}).id));
    expect(ids.size).toBe(200);
  });

  it('defaults the timestamp to the wall clock', () => {
    const before = Date.now();
    const message = clientMessage({ roomId: context.roomId, senderPeerId: 'x' }, 'leave', {});
    expect(message.timestamp).toBeGreaterThanOrEqual(before);
  });
});

describe('MessageDeduplicator', () => {
  it('accepts new ids once', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.accept('a')).toBe(true);
    expect(dedup.accept('a')).toBe(false);
    expect(dedup.accept('b')).toBe(true);
  });

  it('evicts the oldest ids beyond capacity', () => {
    const dedup = new MessageDeduplicator(3);
    for (const id of ['a', 'b', 'c']) {
      expect(dedup.accept(id)).toBe(true);
    }
    expect(dedup.size).toBe(3);
    expect(dedup.accept('d')).toBe(true);
    expect(dedup.size).toBe(3);
    // 'a' was evicted, so it looks new again; the rest are still remembered.
    expect(dedup.accept('a')).toBe(true);
    expect(dedup.accept('c')).toBe(false);
  });

  it('forgets everything on reset', () => {
    const dedup = new MessageDeduplicator();
    dedup.accept('a');
    dedup.reset();
    expect(dedup.size).toBe(0);
    expect(dedup.accept('a')).toBe(true);
  });
});
