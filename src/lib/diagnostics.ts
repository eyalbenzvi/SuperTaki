import { DIAGNOSTICS_CAPACITY } from '../features/game/network/timing.ts';

/**
 * A local record of why connections went wrong.
 *
 * This exists because the honest answer to "why did the game freeze?" was
 * previously a guess. Three causes look identical to a player — the network could
 * never make a path, the tab was suspended by the operating system, or the host
 * reloaded — and they call for three different fixes. Free-form log lines cannot
 * tell them apart after the fact, so each entry carries the specific fields that
 * can:
 *
 * - the ICE candidate types actually in use (`host`/`srflx`/`relay`): the whole
 *   difference between "we never had a path" and "our path died";
 * - the wall-clock versus monotonic gap: a jump in `Date.now()` with missing
 *   monotonic time is suspension, an equal advance in both is a network event;
 * - whether the page was hidden or frozen, and whether a deliberate goodbye
 *   arrived before the channel died — that single bit separates a host who left
 *   from a host who vanished.
 *
 * Nothing here is transmitted anywhere. It lives in `sessionStorage` so it
 * survives the reload it is most often needed to explain, and dies with the tab.
 */

const STORAGE_KEY = 'superTaki:diagnostics';

export type DiagnosticKind =
  | 'phase'
  | 'transportError'
  | 'signalling'
  | 'connectAttempt'
  | 'connectFailed'
  | 'channelClosed'
  | 'channelUnstable'
  /** What kind of network path was actually in use, sampled while it existed. */
  | 'path'
  | 'wake'
  | 'sleep'
  | 'suspicion'
  | 'reachability'
  | 'connectivityProbe'
  | 'hostSnapshot'
  | 'hostRestart'
  | 'handover'
  | 'seatAbsent'
  | 'seatReturned'
  | 'turnSkipped'
  | 'note';

/** Kinds that must never be evicted to make room for routine chatter. */
const NEVER_EVICT: ReadonlySet<DiagnosticKind> = new Set<DiagnosticKind>([
  'transportError',
  'connectFailed',
  'connectivityProbe',
  'path',
  'hostRestart',
  'handover',
  'suspicion',
]);

export interface DiagnosticEntry {
  /** Wall clock, so an entry can be read against a real time of day. */
  readonly at: number;
  /** Monotonic clock, so a gap can be told apart from a clock step. */
  readonly monotonic: number;
  readonly kind: DiagnosticKind;
  readonly detail: string;
  readonly data?: Readonly<Record<string, string | number | boolean>>;
  /** `visible`, `hidden`, or absent outside a browser. */
  readonly visibility?: string;
  /** Effective network type where the browser reports one — absent on iOS. */
  readonly network?: string;
}

function now(): number {
  return Date.now();
}

function monotonic(): number {
  return typeof performance === 'undefined' ? Date.now() : Math.round(performance.now());
}

function visibility(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.visibilityState;
}

function networkType(): string | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
  const connection = (navigator as { connection?: { effectiveType?: string } }).connection;
  return connection?.effectiveType;
}

let entries: DiagnosticEntry[] = [];
let loaded = false;

function load(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      entries = parsed.filter(
        (entry): entry is DiagnosticEntry =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as DiagnosticEntry).at === 'number' &&
          typeof (entry as DiagnosticEntry).kind === 'string',
      );
    }
  } catch {
    /* diagnostics are a convenience; never let them break start-up */
  }
}

let flushHandle: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushHandle !== null) {
    return;
  }
  flushHandle = setTimeout(() => {
    flushHandle = null;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      /* quota or private mode: keep the in-memory ring and carry on */
    }
  }, 500);
}

/**
 * Drops the oldest entry that is safe to drop.
 *
 * Failures and takeovers are the entries someone will actually want, and a 5 s
 * heartbeat would otherwise flush them out of a ring this size within minutes.
 */
function evict(): void {
  const index = entries.findIndex((entry) => !NEVER_EVICT.has(entry.kind));
  entries.splice(index >= 0 ? index : 0, 1);
}

export function record(
  kind: DiagnosticKind,
  detail: string,
  data?: Readonly<Record<string, string | number | boolean | undefined>>,
): void {
  load();
  const cleaned: Record<string, string | number | boolean> = {};
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        cleaned[key] = value;
      }
    }
  }
  const visibilityState = visibility();
  const network = networkType();
  entries.push({
    at: now(),
    monotonic: monotonic(),
    kind,
    detail,
    ...(Object.keys(cleaned).length > 0 ? { data: cleaned } : {}),
    ...(visibilityState ? { visibility: visibilityState } : {}),
    ...(network ? { network } : {}),
  });
  while (entries.length > DIAGNOSTICS_CAPACITY) {
    evict();
  }
  scheduleFlush();
}

export function readDiagnostics(): readonly DiagnosticEntry[] {
  load();
  return entries.slice();
}

export function clearDiagnostics(): void {
  entries = [];
  loaded = true;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Plain-text dump for the "copy" button, oldest first. */
export function formatDiagnostics(): string {
  const rows = readDiagnostics().map((entry) => {
    const time = new Date(entry.at).toISOString().slice(11, 23);
    const fields = entry.data
      ? ` ${Object.entries(entry.data)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' ')}`
      : '';
    const context = [entry.visibility, entry.network].filter(Boolean).join(',');
    return `${time} +${entry.monotonic}ms ${entry.kind} ${entry.detail}${fields}${
      context ? ` (${context})` : ''
    }`;
  });
  return rows.join('\n');
}

/** Test seam: forgets the in-memory ring without touching storage. */
export function __resetDiagnosticsForTests(): void {
  entries = [];
  loaded = false;
  if (flushHandle !== null) {
    clearTimeout(flushHandle);
    flushHandle = null;
  }
}
