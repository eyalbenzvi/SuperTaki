/**
 * The client side of the relay wire protocol.
 *
 * Keep in sync with `worker/src/protocol.ts`, which is the authoritative
 * definition. The protocol is deliberately tiny and versioned (`v` in the
 * hello); the server refuses versions it does not speak, so drift fails loudly
 * at connect time rather than silently mid-game.
 */

export const RELAY_PROTOCOL_VERSION = 1;

/** Ceiling on a single frame, matching the server's. */
export const MAX_FRAME_BYTES = 131_072;

export type DeniedReason = 'idTaken' | 'badHello' | 'protocolVersion';

export type RoutedType = 'open' | 'accept' | 'msg' | 'close';

/** Frames the server sends us. */
export type ServerFrame =
  | { readonly t: 'welcome'; readonly peers: readonly string[] }
  | { readonly t: 'denied'; readonly reason: DeniedReason }
  | { readonly t: 'peerUp'; readonly peerId: string }
  | { readonly t: 'peerDown'; readonly peerId: string }
  | { readonly t: 'gone'; readonly peerId: string; readonly ch: string }
  | { readonly t: RoutedType; readonly from: string; readonly ch: string; readonly d?: unknown };

const ROUTED_TYPES: readonly string[] = ['open', 'accept', 'msg', 'close'];
const DENIED_REASONS: readonly string[] = ['idTaken', 'badHello', 'protocolVersion'];

/**
 * Validates one frame from the server. Anything unrecognised returns `null`
 * and is dropped: the server is trusted for routing, but a frame mangled in
 * transit must not take the session down.
 */
export function parseServerFrame(raw: string): ServerFrame | null {
  if (raw.length > MAX_FRAME_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const frame = value as Record<string, unknown>;
  switch (frame['t']) {
    case 'welcome':
      return Array.isArray(frame['peers']) && frame['peers'].every((p) => typeof p === 'string')
        ? { t: 'welcome', peers: frame['peers'] }
        : null;
    case 'denied':
      return typeof frame['reason'] === 'string' && DENIED_REASONS.includes(frame['reason'])
        ? { t: 'denied', reason: frame['reason'] as DeniedReason }
        : null;
    case 'peerUp':
    case 'peerDown':
      return typeof frame['peerId'] === 'string' ? { t: frame['t'], peerId: frame['peerId'] } : null;
    case 'gone':
      return typeof frame['peerId'] === 'string' && typeof frame['ch'] === 'string'
        ? { t: 'gone', peerId: frame['peerId'], ch: frame['ch'] }
        : null;
    default:
      if (
        typeof frame['t'] === 'string' &&
        ROUTED_TYPES.includes(frame['t']) &&
        typeof frame['from'] === 'string' &&
        typeof frame['ch'] === 'string'
      ) {
        return {
          t: frame['t'] as RoutedType,
          from: frame['from'],
          ch: frame['ch'],
          ...('d' in frame ? { d: frame['d'] } : {}),
        };
      }
      return null;
  }
}

export function helloFrame(peerId: string, claim: string): string {
  return JSON.stringify({ t: 'hello', v: RELAY_PROTOCOL_VERSION, peerId, claim });
}

export function routedFrame(t: RoutedType, to: string, ch: string, d?: unknown): string {
  return JSON.stringify({ t, to, ch, ...(d === undefined ? {} : { d }) });
}
