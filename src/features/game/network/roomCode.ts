import { randomInt } from '../../../lib/id.ts';

/**
 * Room codes are digits you can read out loud, not secrets.
 *
 * Format: six digits (e.g. `482913`), which is a number pad on a phone and one
 * glance to copy off a screen. The host's PeerJS id is derived from the code,
 * which is what makes "join by code" possible without any server-side room
 * registry.
 *
 * Six rather than four, and the reason is not collisions — those the broker
 * catches and the host retries through. It is that *every* string of digits is a
 * valid code. At four digits a single mistyped digit is somebody else's live
 * room rather than an error message, and the whole space of ten thousand rooms
 * can be walked by hand in an evening; at six, a typo lands nowhere and the space
 * is a million. Neither is a password — the room is only open while it is being
 * played — but a private game should at least be hard to wander into.
 */

const ROOM_CODE_LENGTH = 6;
const PEER_ID_PREFIX = 'crush';
const ROOM_CODE_PATTERN = new RegExp(`^\\d{${String(ROOM_CODE_LENGTH)}}$`);

/**
 * Number of distinguishable codes. Collisions are additionally detected by
 * PeerJS (`unavailable-id`), which lets the host regenerate.
 */
export const ROOM_CODE_SPACE = 10 ** ROOM_CODE_LENGTH;

export function generateRoomCode(): string {
  // Digit by digit, so every code in the space is equally likely and leading
  // zeros are as ordinary as any other digit.
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += String(randomInt(10));
  }
  return code;
}

/**
 * Accepts sloppy user input: the spaces and dashes people put between groups of
 * digits, and nothing else. Anything left over fails validation rather than
 * being silently read as a code.
 */
export function normalizeRoomCode(input: string): string {
  return input.trim().replace(/[\s\-_]+/g, '');
}

export function isValidRoomCode(input: string): boolean {
  return ROOM_CODE_PATTERN.test(normalizeRoomCode(input));
}

/**
 * Deterministic host peer id for a room code.
 *
 * `generation` exists so a room can move to another device without the room code
 * changing: after a handover the successor claims generation 1, and a client that
 * cannot find generation 0 knows where to look without any registry to consult.
 * Generation 0 keeps the original, unadorned id, so old invites stay valid.
 */
export function hostPeerIdForRoom(roomCode: string, generation = 0): string {
  const base = `${PEER_ID_PREFIX}-${normalizeRoomCode(roomCode)}`;
  return generation > 0 ? `${base}-h${String(generation)}` : base;
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
  // Carry the transport override across, so an invite generated in
  // same-browser mode still works when opened in another tab. In production the
  // parameter is absent and the link stays clean.
  const transport = url.searchParams.get('transport');
  url.search = transport === 'broadcast' ? `?transport=${transport}` : '';
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
