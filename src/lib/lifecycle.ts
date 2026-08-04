import { record } from './diagnostics.ts';

/**
 * The page lifecycle, in one place.
 *
 * None of these events were handled anywhere: the app watched `online`/`offline`
 * and nothing else. That is the single largest cause of a game "dying" without a
 * network fault, because every browser suspends a backgrounded tab — freezing its
 * timers, and on a phone usually tearing the peer connection down — and on return
 * the app sat waiting for a throttled interval to notice.
 *
 * The signals folded together here:
 *
 * - `visibilitychange` — the ordinary case, a tab going to the background.
 * - `pageshow` with `persisted` — restored from the back/forward cache, where the
 *   whole page was frozen and every connection with it.
 * - `pagehide` — the last chance to say goodbye, and the *only* one that fires
 *   reliably on iOS, where `beforeunload` is routinely ignored.
 * - `freeze` / `resume` — Chrome discarding and restoring a background tab.
 * - `online` / `offline` — a hint about the interface, and no more than a hint.
 *
 * A wake is deliberately coarse: several of these can fire together for one
 * real-world event, and handlers only ever need to hear "you may have missed
 * something, go and check".
 */

export type SleepReason = 'hidden' | 'pagehide' | 'freeze' | 'offline';
export type WakeReason = 'visible' | 'pageshow' | 'resume' | 'online';

type WakeHandler = (reason: WakeReason) => void;
type SleepHandler = (reason: SleepReason) => void;

const wakeHandlers = new Set<WakeHandler>();
const sleepHandlers = new Set<SleepHandler>();
let listening = false;
let awake = true;
/** Coalesces the burst of events that one real transition produces. */
let lastWakeAt = 0;
const WAKE_COALESCE_MS = 250;

function emitWake(reason: WakeReason): void {
  const now = Date.now();
  if (awake && now - lastWakeAt < WAKE_COALESCE_MS) {
    return;
  }
  lastWakeAt = now;
  awake = true;
  record('wake', reason);
  for (const handler of [...wakeHandlers]) {
    handler(reason);
  }
}

function emitSleep(reason: SleepReason): void {
  awake = false;
  record('sleep', reason);
  for (const handler of [...sleepHandlers]) {
    handler(reason);
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    emitWake('visible');
  } else {
    emitSleep('hidden');
  }
}

function onPageShow(event: PageTransitionEvent): void {
  // `persisted` means the page came back from the back/forward cache, in which
  // case every connection it held is gone even though the JavaScript heap looks
  // untouched.
  emitWake('pageshow');
  if (event.persisted) {
    record('wake', 'restored from page cache');
  }
}

function onPageHide(): void {
  emitSleep('pagehide');
}

function onFreeze(): void {
  emitSleep('freeze');
}

function onResume(): void {
  emitWake('resume');
}

function onOnline(): void {
  emitWake('online');
}

function onOffline(): void {
  emitSleep('offline');
}

function start(): void {
  if (listening || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  listening = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('freeze', onFreeze);
  document.addEventListener('resume', onResume);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
}

function stopIfIdle(): void {
  if (!listening || wakeHandlers.size > 0 || sleepHandlers.size > 0) {
    return;
  }
  listening = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.removeEventListener('freeze', onFreeze);
  document.removeEventListener('resume', onResume);
  window.removeEventListener('pageshow', onPageShow);
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
}

/** Subscribes to "the page is back, go and check what you missed". */
export function onWake(handler: WakeHandler): () => void {
  start();
  wakeHandlers.add(handler);
  return () => {
    wakeHandlers.delete(handler);
    stopIfIdle();
  };
}

/** Subscribes to "the page is going away, say what needs saying now". */
export function onSleep(handler: SleepHandler): () => void {
  start();
  sleepHandlers.add(handler);
  return () => {
    sleepHandlers.delete(handler);
    stopIfIdle();
  };
}

/** Whether the page is currently in the foreground, as far as we can tell. */
export function isAwake(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }
  return document.visibilityState === 'visible';
}

/** Test seam: drops every subscription and detaches the listeners. */
export function __resetLifecycleForTests(): void {
  wakeHandlers.clear();
  sleepHandlers.clear();
  awake = true;
  lastWakeAt = 0;
  stopIfIdle();
}
