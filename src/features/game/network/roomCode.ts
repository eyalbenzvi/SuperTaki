import { randomInt } from '../../../lib/id.ts';

/**
 * Room codes are digits you can read out loud, not secrets.
 *
 * Format: six digits (e.g. `482913`), which is a number pad on a phone and one
 * glance to copy off a screen. The code names the room's Durable Object directly —
 * `idFromName(code)` — so "join by code" needs no registry to consult and no
 * indirection to resolve.
 *
 * Six rather than four, and the reason is not collisions — the room itself catches
 * those, by already having players in it. It is that *every* string of digits is a
 * valid code. At four digits a single mistyped digit is somebody else's live room
 * rather than an error message, and the whole space of ten thousand rooms can be
 * walked by hand in an evening; at six, a typo lands nowhere and the space is a
 * million. Neither is a password — the room is only open while it is being played —
 * but a private game should at least be hard to wander into.
 */

const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_PATTERN = new RegExp(`^\\d{${String(ROOM_CODE_LENGTH)}}$`);

/**
 * Number of distinguishable codes.
 *
 * A collision is detected by the room answering `roomTaken` to a request that meant
 * to create it, which the caller retries with a fresh code.
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

export interface InviteDetails {
  readonly roomCode: string;
}

/**
 * Builds the shareable invite URL. Hash routing keeps it valid on GitHub Pages,
 * which cannot rewrite unknown paths to `index.html`.
 *
 * The room code is the whole of it. An invite used to be able to carry a `host=`
 * override too, for a room whose peer id was not the derived one — a room that had
 * been handed to another device. Rooms do not move any more, so the code is enough
 * and always will be.
 */
export function buildInviteUrl(details: InviteDetails, baseUrl: string): string {
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = `#/join?${new URLSearchParams({ room: details.roomCode }).toString()}`;
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
    const room = new URLSearchParams(queryPart.slice(questionIndex + 1)).get('room');
    return room && isValidRoomCode(room) ? { roomCode: normalizeRoomCode(room) } : null;
  }

  if (isValidRoomCode(trimmed)) {
    return { roomCode: normalizeRoomCode(trimmed) };
  }
  return null;
}
