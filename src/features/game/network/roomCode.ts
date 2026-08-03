import { randomInt } from '../../../lib/id.ts';

/**
 * Room codes are human-readable invitations, not secrets.
 *
 * Format: `WORD-WORD-NN` (e.g. `TIGER-MANGO-42`). The host's PeerJS id is
 * derived from the code, which is what makes "join by code" possible without
 * any server-side room registry.
 */

/** Short, unambiguous words that read well in both Hebrew and English UIs. */
const WORDS = [
  'APPLE',
  'AMBER',
  'ARROW',
  'BADGE',
  'BASIL',
  'BEACH',
  'BERRY',
  'BLOOM',
  'BRAVE',
  'BRICK',
  'CANDY',
  'CEDAR',
  'CHESS',
  'CLOUD',
  'COMET',
  'CORAL',
  'CRANE',
  'DAISY',
  'DELTA',
  'DINGO',
  'EAGLE',
  'EMBER',
  'FABLE',
  'FALCON',
  'FERRY',
  'FLINT',
  'FOREST',
  'GLASS',
  'GRAPE',
  'HAZEL',
  'HONEY',
  'IVORY',
  'JAZZY',
  'JOLLY',
  'KAYAK',
  'KOALA',
  'LEMON',
  'LILAC',
  'LOTUS',
  'MANGO',
  'MAPLE',
  'MELON',
  'MOCHA',
  'NOBLE',
  'OCEAN',
  'OLIVE',
  'ONION',
  'ORBIT',
  'PEACH',
  'PEARL',
  'PIANO',
  'PLUM',
  'QUARTZ',
  'RAVEN',
  'RIVER',
  'ROBIN',
  'SALSA',
  'SIREN',
  'SOLAR',
  'STORK',
  'TIGER',
  'TULIP',
  'VIOLET',
  'WALNUT',
] as const;

const PEER_ID_PREFIX = 'crush';
const ROOM_CODE_PATTERN = /^[A-Z]{3,8}-[A-Z]{3,8}-\d{2}$/;

/**
 * Number of distinguishable codes. Collisions are additionally detected by
 * PeerJS (`unavailable-id`), which lets the host regenerate.
 */
export const ROOM_CODE_SPACE = WORDS.length * WORDS.length * 100;

export function generateRoomCode(): string {
  const firstIndex = randomInt(WORDS.length);
  let secondIndex = randomInt(WORDS.length);
  if (secondIndex === firstIndex) {
    secondIndex = (secondIndex + 1) % WORDS.length;
  }
  const digits = String(randomInt(100)).padStart(2, '0');
  return `${WORDS[firstIndex] as string}-${WORDS[secondIndex] as string}-${digits}`;
}

/** Accepts sloppy user input (lowercase, spaces, missing dashes are not fixed). */
export function normalizeRoomCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export function isValidRoomCode(input: string): boolean {
  return ROOM_CODE_PATTERN.test(normalizeRoomCode(input));
}

/** Deterministic host peer id for a room code. */
export function hostPeerIdForRoom(roomCode: string): string {
  return `${PEER_ID_PREFIX}-${normalizeRoomCode(roomCode).toLowerCase()}`;
}

const PEER_ID_PATTERN = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/;

export function isValidPeerId(input: string): boolean {
  return input.length > 0 && input.length <= 64 && PEER_ID_PATTERN.test(input);
}

export interface InviteDetails {
  readonly roomCode: string;
  /** Present only when the host advertised a non-derived peer id. */
  readonly hostPeerId?: string;
}

/**
 * Builds the shareable invite URL. Hash routing keeps it valid on GitHub Pages,
 * which cannot rewrite unknown paths to `index.html`.
 */
export function buildInviteUrl(details: InviteDetails, baseUrl: string): string {
  const url = new URL(baseUrl);
  url.search = '';
  const params = new URLSearchParams({ room: details.roomCode });
  const derived = hostPeerIdForRoom(details.roomCode);
  if (details.hostPeerId && details.hostPeerId !== derived) {
    params.set('host', details.hostPeerId);
  }
  url.hash = `#/join?${params.toString()}`;
  return url.toString();
}

/**
 * Extracts invite details from a full URL, a bare hash, or a pasted room code.
 * Returns `null` when nothing usable is found.
 */
export function parseInvite(input: string): InviteDetails | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const hashIndex = trimmed.indexOf('#');
  const queryPart = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : trimmed;
  const questionIndex = queryPart.indexOf('?');
  if (questionIndex >= 0) {
    const params = new URLSearchParams(queryPart.slice(questionIndex + 1));
    const room = params.get('room');
    const host = params.get('host');
    if (room && isValidRoomCode(room)) {
      const roomCode = normalizeRoomCode(room);
      return host && isValidPeerId(host) ? { roomCode, hostPeerId: host } : { roomCode };
    }
    return null;
  }

  if (isValidRoomCode(trimmed)) {
    return { roomCode: normalizeRoomCode(trimmed) };
  }
  return null;
}
