/**
 * Every deadline the room keeps, on the one alarm a Durable Object gets.
 *
 * The host this replaces had a 5–15 second heartbeat that swept for *everything* on
 * every tick: whether a seat had gone quiet, whether a turn should be passed,
 * whether a robot was overdue, whether a nudge was due. That shape is wrong here
 * twice over. It would wake the object hundreds of times a round, which defeats
 * hibernation — and hibernation is the entire reason this costs nothing. And it was
 * only ever a *polling approximation* of deadlines the room knows exactly: nothing
 * has to be discovered by looking, because the room is the thing that made the
 * appointment.
 *
 * So: a small queue of named deadlines, and one platform alarm always set to the
 * earliest of them. `set` and `clear` re-arm it; `due` reports what has come round,
 * in a fixed order, and forgets it.
 *
 * Held in storage rather than in memory because the object is evicted between
 * messages. A queue that lived in a field would be empty on every wake, which is
 * to say the room would forget every appointment it had made.
 */

/**
 * The platform's side of the alarm, so this can be tested without workerd.
 *
 * Both methods are fire-and-forget: the Durable Object's real ones return promises
 * the runtime is happy to have ignored inside a message handler, and pretending
 * otherwise would make every caller of `set()` async for no benefit.
 */
export interface AlarmPlatform {
  setAlarm(atMs: number): void;
  deleteAlarm(): void;
}

/** What the mux needs from durable storage: one row per pending deadline. */
export interface AlarmStore {
  /** Every pending deadline, in no particular order. */
  entries(): readonly { readonly kind: string; readonly at: number }[];
  put(kind: string, at: number): void;
  delete(kind: string): void;
}

export type AlarmKind =
  /** Pass the turn of a seat that is not there. */
  | 'absentTurn'
  /** A robot's think pause is over. */
  | 'botMove'
  /** A robot did not move at all; pass its seat. */
  | 'botStall'
  /** A seat has been away long enough that a robot may take it. */
  | 'standIn'
  /** A last-card head start has expired, so a robot's catch is worth reconsidering. */
  | 'lastCard'
  /** The table has been waiting on a present player long enough to offer the nudge. */
  | 'idleNudge'
  /** A held seat's grace has run out. */
  | 'seatGrace'
  /** Nobody has been here for the whole idle TTL. Forget the room. */
  | 'ttl';

/**
 * Which deadline is handled first when several come round together.
 *
 * Part of the contract, not an accident of iteration order:
 *
 * - `standIn` leads, because if a robot is about to take a seat over it should take
 *   it *before* that seat is skipped again — otherwise the robot inherits a turn
 *   that has just been passed for it.
 * - `absentTurn` outranks `botMove`: a chair nobody is sitting in must never wait
 *   behind a robot's thinking pause.
 * - `ttl` comes last because it deletes everything, and running it before the
 *   others would silently discard work they were about to do.
 */
const RANK: Readonly<Record<AlarmKind, number>> = {
  standIn: 0,
  absentTurn: 1,
  botStall: 2,
  botMove: 3,
  lastCard: 4,
  idleNudge: 5,
  seatGrace: 6,
  ttl: 7,
};

const KINDS = Object.keys(RANK) as readonly AlarmKind[];

function isAlarmKind(value: string): value is AlarmKind {
  return (KINDS as readonly string[]).includes(value);
}

export class AlarmMux {
  constructor(
    private readonly store: AlarmStore,
    private readonly platform: AlarmPlatform,
  ) {}

  /**
   * Books a deadline, replacing any existing one of the same kind.
   *
   * Replacing rather than keeping the earlier one is right for every kind here:
   * these are all "wake me when X has been true for long enough", and something
   * happening resets X. A rejoin attempt pushing out a pending skip is exactly this
   * call, and it is why the suppression rule needs no flag of its own.
   */
  set(kind: AlarmKind, atMs: number): void {
    this.store.put(kind, Math.round(atMs));
    this.rearm();
  }

  clear(kind: AlarmKind): void {
    if (this.at(kind) === null) {
      return;
    }
    this.store.delete(kind);
    this.rearm();
  }

  clearAll(): void {
    for (const entry of this.store.entries()) {
      this.store.delete(entry.kind);
    }
    this.platform.deleteAlarm();
  }

  /** When this kind is next due, or `null`. */
  at(kind: AlarmKind): number | null {
    for (const entry of this.store.entries()) {
      if (entry.kind === kind) {
        return entry.at;
      }
    }
    return null;
  }

  /** Every pending deadline, earliest first. For diagnostics and tests. */
  pending(): { kind: AlarmKind; at: number }[] {
    return this.store
      .entries()
      .filter((entry): entry is { kind: AlarmKind; at: number } => isAlarmKind(entry.kind))
      .map((entry) => ({ kind: entry.kind, at: entry.at }))
      .sort((a, b) => a.at - b.at || RANK[a.kind] - RANK[b.kind]);
  }

  /**
   * Collects what is due at `nowMs`, deletes it, and hands it back in rank order.
   *
   * Deleting *before* the handlers run, rather than after, is deliberate: a handler
   * that re-books its own kind — an absent seat that is still absent, so check again
   * — must end up with the new deadline rather than have it deleted underneath it.
   */
  due(nowMs: number): AlarmKind[] {
    const ready = this.pending().filter((entry) => entry.at <= nowMs);
    for (const entry of ready) {
      this.store.delete(entry.kind);
    }
    // Not re-armed here. The caller runs the handlers, which book whatever they
    // book, and `rearm()` on each of those calls settles the platform alarm once
    // everything is known — so a wake never leaves the queue unarmed either way.
    this.rearm();
    return ready.sort((a, b) => RANK[a.kind] - RANK[b.kind]).map((entry) => entry.kind);
  }

  /** Points the object's single alarm at the earliest remaining deadline. */
  private rearm(): void {
    const next = this.pending()[0];
    if (next === undefined) {
      this.platform.deleteAlarm();
      return;
    }
    this.platform.setAlarm(next.at);
  }
}

/**
 * An in-memory `AlarmStore` and `AlarmPlatform` pair for tests.
 *
 * `armedAt` is the whole point: it is what the platform was last told, so a test can
 * assert that booking three deadlines results in one alarm, set to the earliest.
 */
export function memoryAlarms(): AlarmStore & AlarmPlatform & { armedAt: number | null } {
  const rows = new Map<string, number>();
  return {
    armedAt: null,
    entries: () => [...rows].map(([kind, at]) => ({ kind, at })),
    put(kind, at) {
      rows.set(kind, at);
    },
    delete(kind) {
      rows.delete(kind);
    },
    setAlarm(atMs) {
      this.armedAt = atMs;
    },
    deleteAlarm() {
      this.armedAt = null;
    },
  };
}
