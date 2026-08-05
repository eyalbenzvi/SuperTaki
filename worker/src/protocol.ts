/**
 * The relay wire protocol, shared by the server and (by copy) the client.
 *
 * The relay knows nothing about Taki. It routes small JSON frames between named
 * peers inside a room, tells everybody who is present, and arbitrates who owns a
 * peer id. Game meaning lives entirely in the payloads (`d`), which the relay
 * forwards without reading.
 *
 * Design rule: every frame a client sends is validated structurally before it
 * touches room state, and the `from` field of every routed frame is stamped by
 * the server — a client cannot speak in another peer's name.
 */

/** Bumped only for incompatible changes; the server refuses other versions. */
export const RELAY_PROTOCOL_VERSION = 1;

/**
 * Ceiling on a single frame. The largest legitimate payload is a full game
 * handover snapshot (tens of KB); everything else is a few hundred bytes.
 */
export const MAX_FRAME_BYTES = 131_072;

/**
 * How long a dead peer's id stays reserved for its claim holder.
 *
 * This is the host-recovery window: a host that crashed can re-present its claim
 * at any time, while a *different* device trying to take the same id must wait
 * this long after the last sign of life. Matches the session layer's seat grace.
 */
export const CLAIM_HOLD_MS = 5 * 60 * 1000;

/**
 * A room with nobody in it is forgotten after this long. Matches the client's
 * snapshot and resume TTLs, so the room outlives every credential that could
 * still return to it.
 */
export const ROOM_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

const PEER_ID_PATTERN = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/;
const CLAIM_PATTERN = /^[a-f0-9]{16,64}$/;
const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const ROOM_CODE_PATTERN = /^\d{6}$/;

export function isValidPeerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && PEER_ID_PATTERN.test(value);
}

export function isValidClaim(value: unknown): value is string {
  return typeof value === 'string' && CLAIM_PATTERN.test(value);
}

export function isValidChannel(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_PATTERN.test(value);
}

/** First frame on every socket: who I am, and my proof of ownership. */
export interface HelloFrame {
  readonly t: 'hello';
  readonly v: number;
  readonly peerId: string;
  readonly claim: string;
}

/**
 * Frames routed peer-to-peer through the relay. `open`/`accept`/`close` manage a
 * virtual connection (`ch` names it, minted by the opener); `msg` carries data.
 */
export type RoutedType = 'open' | 'accept' | 'msg' | 'close';

export interface RoutedFrame {
  readonly t: RoutedType;
  readonly to: string;
  readonly ch: string;
  readonly d?: unknown;
}

export type ClientFrame = HelloFrame | RoutedFrame;

/** Server → client frames. */
export type DeniedReason = 'idTaken' | 'badHello' | 'protocolVersion';

export type ServerFrame =
  | { readonly t: 'welcome'; readonly peers: readonly string[] }
  | { readonly t: 'denied'; readonly reason: DeniedReason }
  | { readonly t: 'peerUp'; readonly peerId: string }
  | { readonly t: 'peerDown'; readonly peerId: string }
  /** The routed frame's target is not in the room. */
  | { readonly t: 'gone'; readonly peerId: string; readonly ch: string }
  | {
      readonly t: 'open' | 'accept' | 'msg' | 'close';
      readonly from: string;
      readonly ch: string;
      readonly d?: unknown;
    };

const ROUTED_TYPES: readonly string[] = ['open', 'accept', 'msg', 'close'];

/**
 * Parses and validates one client frame. Returns `null` for anything malformed —
 * the caller drops the socket, because a client that sends garbage once will
 * send it again.
 */
export function parseClientFrame(raw: string): ClientFrame | null {
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
  if (frame['t'] === 'hello') {
    if (frame['v'] !== RELAY_PROTOCOL_VERSION) {
      // Distinguished so the server can answer `denied(protocolVersion)` instead
      // of a silent drop that reads as a network fault.
      return { t: 'hello', v: typeof frame['v'] === 'number' ? frame['v'] : -1, peerId: '', claim: '' };
    }
    if (!isValidPeerId(frame['peerId']) || !isValidClaim(frame['claim'])) {
      return null;
    }
    return { t: 'hello', v: RELAY_PROTOCOL_VERSION, peerId: frame['peerId'], claim: frame['claim'] };
  }
  if (typeof frame['t'] === 'string' && ROUTED_TYPES.includes(frame['t'])) {
    if (!isValidPeerId(frame['to']) || !isValidChannel(frame['ch'])) {
      return null;
    }
    return {
      t: frame['t'] as RoutedType,
      to: frame['to'],
      ch: frame['ch'],
      ...('d' in frame ? { d: frame['d'] } : {}),
    };
  }
  return null;
}
