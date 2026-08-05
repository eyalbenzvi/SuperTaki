/** Random identifier helpers built on the Web Crypto API. */

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Lowercase hex string of `byteLength` random bytes. */
export function randomHex(byteLength: number): string {
  return Array.from(randomBytes(byteLength), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Opaque message identifier used for de-duplication. */
export function createMessageId(): string {
  return randomHex(8);
}

/** Stable anonymous player identity, generated locally and never derived from user data. */
export function createPlayerId(): string {
  return `pl_${randomHex(8)}`;
}

/** Secret used to prove ownership of a seat after a page refresh. */
export function createResumeToken(): string {
  return randomHex(16);
}

/**
 * Secret that proves ownership of a room's peer id to the relay. Presenting it
 * again is what lets a host take its room code back after a crash.
 */
export function createRoomClaim(): string {
  return randomHex(16);
}

/** Random integer in [0, maxExclusive) drawn from the CSPRNG. */
export function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 0 || !Number.isInteger(maxExclusive)) {
    throw new RangeError('maxExclusive must be a positive integer');
  }
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const view = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(view);
    value = view[0] as number;
  } while (value >= limit);
  return value % maxExclusive;
}
