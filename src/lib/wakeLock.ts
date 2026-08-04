import { createLogger } from './logger.ts';

/**
 * Keeps the screen awake while a game is on the table.
 *
 * A phone that dims and locks is the most ordinary way a player "disconnects":
 * the tab is suspended, the peer connection dies with it, and nobody touched
 * anything. This does not fix a background tab — nothing in a web page can — but
 * it prevents the case where the game is *in front of the player* and the device
 * puts itself to sleep anyway.
 *
 * Every failure is swallowed. The lock is unsupported on several browsers, is
 * refused outside a secure context, and is revoked whenever the page is hidden;
 * none of that is worth a word to the player, so an absent lock simply means the
 * old behaviour.
 */

const log = createLogger('wakelock');

interface SentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<SentinelLike>;
}

function api(): WakeLockLike | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  const candidate = (navigator as { wakeLock?: WakeLockLike }).wakeLock;
  return candidate ?? null;
}

export function isWakeLockSupported(): boolean {
  return api() !== null;
}

let sentinel: SentinelLike | null = null;
let wanted = false;

/** Asks for the lock. Safe to call repeatedly, including after a wake. */
export async function requestWakeLock(): Promise<void> {
  wanted = true;
  const wakeLock = api();
  if (!wakeLock || sentinel !== null) {
    return;
  }
  try {
    const granted = await wakeLock.request('screen');
    granted.addEventListener('release', () => {
      sentinel = null;
      // The browser drops the lock whenever the page is hidden. Re-requesting is
      // the caller's job on the next wake, not something to retry blindly here.
    });
    sentinel = granted;
    log.debug('screen wake lock held');
  } catch (error) {
    log.debug('screen wake lock refused', error);
  }
}

export async function releaseWakeLock(): Promise<void> {
  wanted = false;
  const held = sentinel;
  sentinel = null;
  if (!held || held.released === true) {
    return;
  }
  try {
    await held.release();
  } catch (error) {
    log.debug('releasing the wake lock failed', error);
  }
}

/** Re-acquires the lock after a wake, but only if somebody still wants it. */
export async function refreshWakeLock(): Promise<void> {
  if (wanted && sentinel === null) {
    await requestWakeLock();
  }
}

/** Test seam. */
export function __resetWakeLockForTests(): void {
  sentinel = null;
  wanted = false;
}
