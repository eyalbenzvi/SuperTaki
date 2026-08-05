import { record } from '../../../lib/diagnostics.ts';

/**
 * Whether the device can reach the internet at all, as opposed to merely having
 * an interface up.
 *
 * `navigator.onLine` is true for a WiFi network with no route and true behind a
 * captive portal — that is, true in exactly the situations where nothing works —
 * and it flaps during a network handover. A same-origin request is the honest
 * test, it needs nothing but the bytes the site already serves, and the existing
 * `connect-src 'self'` covers it.
 */
export async function probeReachability(timeoutMs = 3_000): Promise<boolean> {
  if (typeof fetch !== 'function' || typeof window === 'undefined') {
    return true;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const url = new URL(window.location.href);
    url.hash = '';
    url.search = `probe=${Date.now()}`;
    await fetch(url.toString(), { method: 'HEAD', cache: 'no-store', signal: controller.signal });
    record('reachability', 'origin reachable');
    return true;
  } catch {
    record('reachability', 'origin unreachable');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
