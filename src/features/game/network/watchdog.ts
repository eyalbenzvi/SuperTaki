import { LATE_TICK_FACTOR } from './timing.ts';

/**
 * A heartbeat that knows the difference between "the peer is gone" and "we were
 * asleep".
 *
 * Every liveness check in this app used to ride a bare `setInterval` and compare
 * wall-clock silence against a threshold. A browser throttles or freezes the
 * timers of a backgrounded tab, so the next tick arrived long after it was due
 * and immediately concluded that the *peer* had died — when the only thing that
 * had stopped was us. That produced most of the phantom disconnects in the
 * product.
 *
 * So the tick carries how late it was. A tick later than `LATE_TICK_FACTOR`
 * intervals means the local page stopped running, and nobody may be convicted on
 * that evidence. What the caller does instead is *probe immediately*: if the tab
 * really was suspended, ICE consent has very likely already expired (RFC 7675
 * gives it 30 s) and the channel is dead, so extending grace would be exactly
 * backwards. The right response to a wake is a question, asked at once, with a
 * short deadline.
 */

export interface WatchdogTick {
  /** Wall-clock milliseconds since the previous tick. */
  readonly elapsedMs: number;
  /** True when the gap was long enough that the page must have been suspended. */
  readonly late: boolean;
  /** The interval in force for this tick. */
  readonly intervalMs: number;
}

export interface Watchdog {
  /** Restarts the timer, picking up a changed interval. */
  restart(): void;
  /** Runs the tick handler now, as a wake should. */
  poke(): void;
  stop(): void;
}

export interface WatchdogOptions {
  /** Interval in force, re-read on every tick so it can adapt. */
  readonly intervalMs: () => number;
  readonly onTick: (tick: WatchdogTick) => void;
  readonly now?: () => number;
}

export function createWatchdog(options: WatchdogOptions): Watchdog {
  // Wrapped, not captured: a reference freezes whichever clock was installed when
  // the watchdog was built, and this module's whole job is reasoning about time.
  const now = options.now ?? ((): number => Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentInterval = options.intervalMs();
  let lastTickAt = now();
  let stopped = false;

  const fire = (): void => {
    if (stopped) {
      return;
    }
    const at = now();
    const elapsedMs = at - lastTickAt;
    lastTickAt = at;
    const intervalMs = currentInterval;
    options.onTick({ elapsedMs, late: elapsedMs > intervalMs * LATE_TICK_FACTOR, intervalMs });

    const next = options.intervalMs();
    if (next !== currentInterval) {
      currentInterval = next;
      schedule();
    }
  };

  function schedule(): void {
    if (timer !== null) {
      clearInterval(timer);
    }
    timer = setInterval(fire, currentInterval);
  }

  schedule();

  return {
    restart(): void {
      if (stopped) {
        return;
      }
      currentInterval = options.intervalMs();
      lastTickAt = now();
      schedule();
    },
    poke(): void {
      fire();
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Outstanding liveness probes, matched by nonce.
 *
 * Wall-clock silence was the wrong signal in a second way: `lastHostMessageAt`
 * was bumped by *any* inbound message, including broadcasts caused by somebody
 * else's move, so "the host answered me" was satisfied without the host answering
 * anything. Counting unanswered probes is evidence; counting quiet milliseconds is
 * not.
 */
export class ProbeTracker {
  private readonly outstanding = new Map<string, number>();
  private lastRoundTripMs: number | null = null;

  constructor(private readonly capacity = 16) {}

  sent(nonce: string, at: number): void {
    this.outstanding.set(nonce, at);
    while (this.outstanding.size > this.capacity) {
      const oldest = this.outstanding.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.outstanding.delete(oldest);
    }
  }

  /** Records an answer. Returns the round trip, or `null` for an unknown nonce. */
  answered(nonce: string, at: number): number | null {
    const sentAt = this.outstanding.get(nonce);
    if (sentAt === undefined) {
      return null;
    }
    // An answer proves every earlier probe reached them too.
    for (const [key, value] of [...this.outstanding]) {
      if (value <= sentAt) {
        this.outstanding.delete(key);
      }
    }
    this.lastRoundTripMs = at - sentAt;
    return this.lastRoundTripMs;
  }

  get unanswered(): number {
    return this.outstanding.size;
  }

  /** Age of the oldest probe still waiting, or `null` when nothing is outstanding. */
  oldestAgeMs(at: number): number | null {
    let oldest: number | null = null;
    for (const sentAt of this.outstanding.values()) {
      if (oldest === null || sentAt < oldest) {
        oldest = sentAt;
      }
    }
    return oldest === null ? null : at - oldest;
  }

  get roundTripMs(): number | null {
    return this.lastRoundTripMs;
  }

  reset(): void {
    this.outstanding.clear();
    this.lastRoundTripMs = null;
  }
}
