/**
 * Every deadline in the connection layer, in one place.
 *
 * These numbers used to live in three files and disagree with each other. The
 * rules that generate them:
 *
 * 1. **One authority per deadline.** Anything about the lifetime of a *seat* is
 *    the host's to decide, travels in the lobby snapshot, and is *derived* by the
 *    client — never re-declared. Two constants that have to agree eventually will
 *    not; one constant plus a subtraction cannot disagree.
 * 2. **Detection thresholds are counted in missed probes, never in raw
 *    milliseconds**, with a floor of three, so a single lost round trip on a
 *    mobile network never convicts anybody.
 * 3. **A "give up" deadline must exceed the other side's "keep trying" deadline**
 *    for the same resource by the worst realistic recovery time: a 40 s
 *    WiFi/cellular handover, plus up to 75 s of the broker holding a dropped peer
 *    id, plus one backoff round — call it three minutes.
 * 4. **Nothing terminal is decided from a single failed attempt or a single timer
 *    expiry.**
 */

/** Probe cadence while the local player has something at stake. */
export const PROBE_INTERVAL_BUSY_MS = 5_000;

/**
 * Probe cadence the rest of the time.
 *
 * A fixed 5 s cadence never lets a cellular modem reach its idle state, and a
 * turn-based card game does not need sub-second failure detection. The bytes are
 * irrelevant; the radio is not.
 */
export const PROBE_INTERVAL_IDLE_MS = 15_000;

/** Missed probes before a peer is shown as unstable. Three is the floor. */
export const UNSTABLE_AFTER_MISSES = 3;

/** Missed probes before a peer is treated as silent. */
export const SILENT_AFTER_MISSES = 6;

/**
 * Floor under the "peer is silent" deadline.
 *
 * ICE consent freshness (RFC 7675) expires after 30 s of unanswered checks, and
 * before that the browser's own ICE agent has not given up — so neither should
 * we, however fast we happen to be probing.
 */
export const PEER_SILENT_FLOOR_MS = 30_000;

/**
 * When to stop waiting and rebuild the channel.
 *
 * Past 30 s of consent plus a margin, the ICE agent has surrendered too, so
 * there is nothing left to wait for.
 */
export const CHANNEL_DEAD_MS = 45_000;

/**
 * Deadline for the liveness probe fired after a wake or a late tick.
 *
 * Deliberately short: a tab that just woke needs an answer now, not a grace
 * period.
 */
export const PROBE_DEADLINE_MS = 3_000;

/**
 * How late a watchdog tick has to be before we conclude *we* were asleep rather
 * than that the peer died.
 *
 * Three intervals rather than two: two is inside ordinary foreground timer jank
 * on a loaded low-end phone, and a false "we slept" suppresses a real
 * conviction.
 */
export const LATE_TICK_FACTOR = 3;

/** How long to wait for the broker to assign a peer id. Re-armable. */
export const SIGNALLING_READY_MS = 12_000;

/**
 * Data-connection budget, first attempt versus later ones.
 *
 * A flat 15 s was wrong in both directions: too long for the attempt a player is
 * watching, and too short for a *relayed* candidate pair on slow cellular, which
 * can need most of 20 s to nominate.
 */
export const CONNECT_TIMEOUT_FIRST_MS = 8_000;
export const CONNECT_TIMEOUT_RETRY_MS = 20_000;

/** Join handshake budget. Must exceed the host's own turnaround, and is not terminal. */
export const JOIN_TIMEOUT_MS = 15_000;

/**
 * Reconnection backoff, in seconds: 0, 1, 2, 5, 10, 20, 30.
 *
 * The first attempt is immediate because the thing that triggered it — a wake,
 * an `online` event, a channel close — is new information. The 30 s cap keeps a
 * five-player room to a defensible number of lookups against a donated broker.
 */
export const RECONNECT_BACKOFF_MS = [0, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

/** Proportional jitter applied to every backoff delay, so peers do not return in lockstep. */
export const BACKOFF_JITTER = 0.3;

/** Grace for a seat that drops *before* the game starts. */
export const LOBBY_GRACE_MS = 30_000;

/**
 * How long a seat is held mid-game before the table may vacate it.
 *
 * Must exceed the worst realistic recovery (rule 3 above) with margin. This is
 * the host's number and it goes on the wire, so the countdown a player sees is
 * never a promise their own timer will break.
 */
export const SEAT_GRACE_MS = 300_000;

/** How much sooner than the host's grace a client stops trying, so it never races the vacate. */
export const RECONNECT_DEADLINE_MARGIN_MS = 30_000;

/**
 * Before skipping the turn of a player whose channel is provably closed.
 *
 * Short on purpose. The host already *knows* the channel is gone, so waiting
 * learns nothing — and a skip costs the absent player no cards at all, which is
 * what makes a short window affordable.
 */
export const ABSENT_TURN_GRACE_CLOSED_MS = 12_000;

/** The same, for a player who is merely unstable: they may still be there. */
export const ABSENT_TURN_GRACE_UNSTABLE_MS = 30_000;

/**
 * A pending skip is called off if the seat tried to rejoin this recently.
 *
 * An observed reconnection attempt is far stronger evidence that somebody is
 * coming back than silence is that they are not, and it costs nothing to record.
 */
export const RESUME_ATTEMPT_SUPPRESSES_SKIP_MS = 20_000;

/**
 * How long a returning host keeps trying to reclaim its own room code.
 *
 * The PeerJS server's `alive_timeout` defaults to 60 s, so a host whose tab was
 * killed by the OS can find its id still registered for a full minute. Giving up
 * earlier means conceding the room code — and invalidating every invite already
 * sent — at the exact moment it was still recoverable.
 */
export const HOST_ID_RETRY_WINDOW_MS = 75_000;

/** Attempt schedule inside that window, in ms from the first try. */
export const HOST_ID_RETRY_SCHEDULE_MS = [0, 2_000, 5_000, 10_000, 20_000, 35_000, 55_000, 75_000] as const;

/**
 * How long a host may fail to re-register before it tells the table so.
 *
 * A host whose broker socket is dead keeps serving everyone already connected
 * but cannot accept anybody new. Saying nothing is the dishonest option.
 */
export const HOST_SELF_DEMOTE_MS = 90_000;

/** Budget for a named successor to confirm a voluntary handover. */
export const HANDOFF_TIMEOUT_MS = 10_000;

/**
 * How long one submitted move keeps the table locked with no answer.
 *
 * 5 s was shorter than a single connection attempt, so any hiccup released the
 * lock and invited a second tap. This is now only a backstop: the lock is
 * released by an explicit acknowledgement.
 */
export const ACTION_LOCK_MS = 20_000;

/** Soft nudge for a player who is connected but not looking at their phone. */
export const IDLE_TURN_NUDGE_MS = 30_000;

/** Entries kept in the local diagnostics ring. */
export const DIAGNOSTICS_CAPACITY = 500;

/** Deadline for the local, broker-free connectivity probe. */
export const CONNECTIVITY_PROBE_MS = 4_000;

/**
 * Bounded, jittered backoff.
 *
 * `random` is injectable so tests can assert the bounds without flaking.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attempt, 0), RECONNECT_BACKOFF_MS.length - 1);
  const base = RECONNECT_BACKOFF_MS[index] as number;
  if (base === 0) {
    return 0;
  }
  const spread = base * BACKOFF_JITTER;
  return Math.round(base - spread + random() * spread * 2);
}

/** Probe interval for the current situation. */
export function probeInterval(busy: boolean): number {
  return busy ? PROBE_INTERVAL_BUSY_MS : PROBE_INTERVAL_IDLE_MS;
}

/** How long silence has to last, at this cadence, before a peer counts as silent. */
export function silentAfterMs(intervalMs: number): number {
  return Math.max(intervalMs * SILENT_AFTER_MISSES, PEER_SILENT_FLOOR_MS);
}

/** How long silence has to last, at this cadence, before a peer counts as unstable. */
export function unstableAfterMs(intervalMs: number): number {
  return intervalMs * UNSTABLE_AFTER_MISSES;
}

/**
 * The client's own give-up deadline, derived from the host's seat grace so the
 * two can never contradict each other.
 */
export function reconnectDeadlineMs(seatGraceMs: number): number {
  return Math.max(seatGraceMs - RECONNECT_DEADLINE_MARGIN_MS, RECONNECT_DEADLINE_MARGIN_MS);
}
