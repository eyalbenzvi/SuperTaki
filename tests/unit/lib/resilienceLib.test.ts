import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROBE_INTERVAL_IDLE_MS,
  RECONNECT_BACKOFF_MS,
  DIAGNOSTICS_CAPACITY,
  SEAT_GRACE_MS,
  backoffDelay,
  reconnectDeadlineMs,
  ABSENT_TURN_GRACE_CLOSED_MS,
  PROBE_DEADLINE_MS,
} from '../../../src/features/game/network/timing.ts';
import {
  __resetDiagnosticsForTests,
  clearDiagnostics,
  formatDiagnostics,
  readDiagnostics,
  record,
} from '../../../src/lib/diagnostics.ts';
import { __resetLifecycleForTests, isAwake, onSleep, onWake } from '../../../src/lib/lifecycle.ts';
import {
  __resetWakeLockForTests,
  isWakeLockSupported,
  refreshWakeLock,
  releaseWakeLock,
  requestWakeLock,
} from '../../../src/lib/wakeLock.ts';

beforeEach(() => {
  __resetLifecycleForTests();
  __resetDiagnosticsForTests();
  __resetWakeLockForTests();
  clearDiagnostics();
});

afterEach(() => {
  vi.useRealTimers();
  __resetLifecycleForTests();
});

describe('the timeout hierarchy', () => {
  it('lets a client stop strictly before the room may vacate the seat', () => {
    // The two used to be independent constants pointing in opposite directions, so
    // minutes were spent reconnecting into a seat that had already been freed.
    expect(reconnectDeadlineMs(SEAT_GRACE_MS)).toBeLessThan(SEAT_GRACE_MS);
  });

  it('keeps the liveness probe slow enough for a radio to idle', () => {
    // The probe is answered by the Cloudflare runtime without waking the room, so a
    // faster cadence would buy nothing and cost a modem that never sleeps.
    expect(PROBE_INTERVAL_IDLE_MS).toBeGreaterThanOrEqual(10_000);
    expect(PROBE_DEADLINE_MS).toBeLessThan(PROBE_INTERVAL_IDLE_MS);
  });

  it('gives an absent seat a grace far shorter than the seat is held for', () => {
    // A blip is answered by a passed turn, which costs the seat the one card the
    // turn itself would have cost; losing the seat is a different and much slower
    // decision.
    expect(ABSENT_TURN_GRACE_CLOSED_MS).toBeLessThan(SEAT_GRACE_MS / 10);
  });

  it('retries immediately the first time, then backs off with jitter', () => {
    // The trigger for the first attempt — a wake, an `online` event, a channel
    // close — is new information, so waiting a second to act on it is waste.
    expect(backoffDelay(0)).toBe(0);

    const later = RECONNECT_BACKOFF_MS[3] as number;
    for (const random of [0, 0.5, 0.999]) {
      const delay = backoffDelay(3, () => random);
      expect(delay).toBeGreaterThanOrEqual(later * 0.7 - 1);
      expect(delay).toBeLessThanOrEqual(later * 1.3 + 1);
    }
  });

  it('caps the backoff, so a room full of clients stays a good citizen', () => {
    const cap = RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1] as number;
    expect(backoffDelay(99, () => 0.5)).toBeCloseTo(cap, -2);
    // The signalling broker is a donated service shared with everybody else using
    // PeerJS, and an unbounded retry loop against it is not ours to run.
    expect(cap).toBeGreaterThanOrEqual(20_000);
  });
});

describe('the page lifecycle', () => {
  it('reports a wake for every way a page can come back', () => {
    const reasons: string[] = [];
    const off = onWake((reason) => reasons.push(reason));

    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('online'));

    expect(reasons.length).toBeGreaterThan(0);
    off();
  });

  it('coalesces the burst one real transition produces', () => {
    const reasons: string[] = [];
    const off = onWake((reason) => reasons.push(reason));

    // A single unlock can fire visibilitychange, pageshow and resume together;
    // a handler only ever needs to hear "go and check" once.
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    expect(reasons.length).toBeLessThanOrEqual(2);
    off();
  });

  it('reports the last chance to speak before the page goes away', () => {
    const reasons: string[] = [];
    const off = onSleep((reason) => reasons.push(reason));

    // `pagehide` is the only one of these that fires reliably on a phone, which is
    // why the host's goodbye is sent from it rather than from `beforeunload`.
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('offline'));

    expect(reasons).toContain('pagehide');
    expect(reasons).toContain('offline');
    off();
  });

  it('unsubscribes cleanly', () => {
    let count = 0;
    const off = onWake(() => {
      count += 1;
    });
    off();
    window.dispatchEvent(new Event('pageshow'));
    expect(count).toBe(0);
  });

  it('knows whether the page is in the foreground', () => {
    expect(typeof isAwake()).toBe('boolean');
  });
});

describe('diagnostics', () => {
  it('survives a reload, because the failure it explains usually caused one', () => {
    /*
     * The ring is in `sessionStorage` for exactly one reason: the interesting entries
     * are the ones written just before something went wrong, and what a player does
     * when something goes wrong is reload. A log that started empty on the way back
     * would never hold the lines anybody wanted.
     */
    window.sessionStorage.setItem(
      'superTaki:diagnostics',
      JSON.stringify([
        { at: 1_700_000_000_000, monotonic: 12, kind: 'connectFailed', detail: 'from before' },
        { nonsense: true },
      ]),
    );
    __resetDiagnosticsForTests();

    const entries = readDiagnostics();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toBe('from before');
    // And a row that does not parse is dropped rather than taking the log with it.
    expect(formatDiagnostics()).toContain('from before');
  });

  it('ignores a stored log that is not a list at all', () => {
    window.sessionStorage.setItem('superTaki:diagnostics', '{"not":"an array"}');
    __resetDiagnosticsForTests();
    expect(readDiagnostics()).toHaveLength(0);
  });

  it('keeps what explains a failure when routine chatter fills the ring', () => {
    record('connectFailed', 'the one that matters');
    for (let index = 0; index < DIAGNOSTICS_CAPACITY + 20; index += 1) {
      record('note', `chatter ${String(index)}`);
    }
    const kinds = readDiagnostics().map((entry) => entry.kind);
    expect(kinds).toContain('connectFailed');
    expect(readDiagnostics().length).toBeLessThanOrEqual(DIAGNOSTICS_CAPACITY);
  });

  it('records what distinguishes one failure from another', () => {
    record('connectFailed', 'peerUnavailable', { attempt: 2, joined: false });
    const entries = readDiagnostics();
    const entry = entries.at(-1);

    expect(entry?.kind).toBe('connectFailed');
    // Both clocks, because a wall-clock jump with no monotonic advance is a
    // suspended tab and an equal advance in both is a network event — and nothing
    // else can tell those apart after the fact.
    expect(typeof entry?.at).toBe('number');
    expect(typeof entry?.monotonic).toBe('number');
    expect(entry?.data).toMatchObject({ attempt: 2, joined: false });
  });

  it('drops undefined fields rather than recording them', () => {
    record('note', 'partial', { present: 1, absent: undefined });
    expect(readDiagnostics().at(-1)?.data).toEqual({ present: 1 });
  });

  it('keeps failures when routine chatter would otherwise flush them out', () => {
    record('connectFailed', 'the one that matters');
    for (let i = 0; i < 700; i += 1) {
      record('phase', `noise-${String(i)}`);
    }
    const entries = readDiagnostics();
    expect(entries.length).toBeLessThanOrEqual(500);
    expect(entries.some((entry) => entry.detail === 'the one that matters')).toBe(true);
  });

  it('formats a dump somebody can paste into a message', () => {
    record('note', 'down');
    const text = formatDiagnostics();
    expect(text).toContain('note');
    expect(text).toContain('down');
  });

  it('can be cleared', () => {
    record('note', 'something');
    clearDiagnostics();
    expect(readDiagnostics()).toHaveLength(0);
  });
});

describe('the screen wake lock', () => {
  interface FakeSentinel {
    released: boolean;
    release(): Promise<void>;
    addEventListener(type: 'release', listener: () => void): void;
    fire(): void;
  }

  function sentinel(): FakeSentinel {
    const listeners: (() => void)[] = [];
    return {
      released: false,
      release(): Promise<void> {
        this.released = true;
        return Promise.resolve();
      },
      addEventListener(_type: 'release', listener: () => void): void {
        listeners.push(listener);
      },
      fire(): void {
        for (const listener of listeners) {
          listener();
        }
      },
    };
  }

  function install(request: (type: 'screen') => Promise<FakeSentinel>): void {
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request },
      configurable: true,
      writable: true,
    });
  }

  function uninstall(): void {
    Object.defineProperty(navigator, 'wakeLock', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }

  afterEach(uninstall);

  it('asks once even when two callers race', async () => {
    /*
     * The bug this pins. The guard was `sentinel !== null`, and it sits *before* an
     * await — so a screen coming back, which fires the game-screen effect and the
     * wake handler in the same turn, produced two requests. The second overwrote the
     * first, and the orphan was never released: the phone then stayed awake after the
     * game had ended.
     */
    let asked = 0;
    const granted = sentinel();
    install(() => {
      asked += 1;
      return Promise.resolve(granted);
    });
    expect(isWakeLockSupported()).toBe(true);

    await Promise.all([requestWakeLock(), requestWakeLock()]);
    expect(asked).toBe(1);

    await releaseWakeLock();
    expect(granted.released).toBe(true);
  });

  it('re-acquires after the browser revokes it, but only if it is still wanted', async () => {
    const first = sentinel();
    const second = sentinel();
    let asked = 0;
    install(() => {
      asked += 1;
      return Promise.resolve(asked === 1 ? first : second);
    });

    await requestWakeLock();
    // The browser drops the lock whenever the page is hidden; that is not a failure
    // and not something to retry blindly from inside the release handler.
    first.fire();
    await refreshWakeLock();
    expect(asked).toBe(2);

    await releaseWakeLock();
    second.fire();
    await refreshWakeLock();
    // Nobody wants it any more, so nothing is asked for.
    expect(asked).toBe(2);
  });

  it('says nothing to the player when the browser refuses', async () => {
    install(() => Promise.reject(new Error('not allowed in this context')));
    await expect(requestWakeLock()).resolves.toBeUndefined();
    // And a release with no lock held is equally quiet.
    await expect(releaseWakeLock()).resolves.toBeUndefined();
  });

  it('is simply absent where the API is not implemented', async () => {
    uninstall();
    expect(isWakeLockSupported()).toBe(false);
    await expect(requestWakeLock()).resolves.toBeUndefined();
    await expect(refreshWakeLock()).resolves.toBeUndefined();
  });
});
