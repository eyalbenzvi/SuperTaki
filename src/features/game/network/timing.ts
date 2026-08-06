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

/**
 * How much longer than the budget the caller waits before enforcing it itself.
 *
 * The transport is asked to honour the budget and does; this is the backstop for
 * the case where it cannot — a promise that never settles freezes the session with
 * no attempt in flight, no deadline and nothing said to the player, which is the
 * exact shape of the reconnect bug this work exists to remove. The grace keeps the
 * transport's own, more specific error the one that is normally reported.
 */
export const CONNECT_DEADLINE_GRACE_MS = 2_000;

/** Join handshake budget. Must exceed the host's own turnaround, and is not terminal. */
export const JOIN_TIMEOUT_MS = 15_000;

/**
 * Reconnection backoff, in seconds: 0, 1, 2, 5, 10, 20, 30.
 *
 * The first attempt is immediate because the thing that triggered it — a wake,
 * an `online` event, a channel close — is new information. The 30 s cap keeps a
 * quiet ceiling on how hard a room full of phones hammers the relay.
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
 * How long a returning host keeps trying to reclaim its own room code, as a
 * schedule of attempt times.
 *
 * The relay recognises the host's stored claim and hands the id straight back,
 * so the first attempt normally succeeds — the rest of the schedule exists for
 * the network, not the server: a host reclaiming from a train needs the loop to
 * survive a tunnel's worth of failed connects before it concedes the code and
 * invalidates every invite already sent.
 */
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

/**
 * How long the nudge stays on screen for the player who received it.
 *
 * Long enough to be read by somebody who has just picked the phone up, short
 * enough that it is gone before it becomes a second thing to dismiss.
 */
export const NUDGE_NOTICE_MS = 12_000;

/**
 * How long the "somebody was caught on their last card" banner stays up.
 *
 * Shorter than the nudge: it reports something that has already happened and
 * needs no answer, so it only has to survive being read. It clears itself for
 * the same reason the nudge does — nobody should have to dismiss a bulletin.
 */
export const CAUGHT_NOTICE_MS = 8_000;

/**
 * The head start a player gets on their own last card.
 *
 * From the moment a hand comes down to a single card, nobody may call that player
 * out for not having declared until this has passed. It exists because the two
 * halves of the moment are not simultaneous on a screen the way they are at a
 * table: the hand reaches one card, and only then does a catch button appear on
 * everybody else's screen. Without a window the catch could land on the far side
 * of that gap.
 *
 * Thirty milliseconds: barely more than a frame, and deliberately so. It settles
 * that ordering and nothing else. A quarter of a second sat here first and read as
 * a delay — callers watched a seat drop to one card and found the button dead —
 * because anything that long stops covering the gap and starts protecting the
 * silence. A genuinely silent player stays exposed for as long as they stay silent
 * either way.
 */
export const LAST_CARD_GRACE_MS = 30;

/**
 * How long a robot appears to think before it plays.
 *
 * Not decoration. A robot that answered in the same tick as the snapshot that
 * gave it the turn would make the table unreadable — cards would appear to play
 * themselves — and it would take every contested moment (a catch, a breaker)
 * before a human could reach for it. The range is jittered from the room's own
 * seeded stream, so a replay is exact while no two robots move in lockstep.
 */
export const BOT_THINK_MIN_MS = 700;
export const BOT_THINK_MAX_MS = 1_700;

/**
 * The pause between cards *inside* an open Taki sequence.
 *
 * A six-card sequence at full thinking pace is ten seconds of watching somebody
 * else's hand empty. At a real table those cards go down in a rattle, and the
 * decision has already been made.
 */
export const BOT_SEQUENCE_MIN_MS = 260;
export const BOT_SEQUENCE_MAX_MS = 520;

/**
 * Before a robot declares its own last card.
 *
 * Deliberately far above {@link LAST_CARD_GRACE_MS}: this is the window in which a
 * human can call the robot out, and it is the whole reason robots are catchable at
 * all. A robot that declared in the same tick would be immune to the one rule the
 * other players enforce themselves.
 */
export const BOT_DECLARE_MIN_MS = 900;
export const BOT_DECLARE_MAX_MS = 2_000;

/**
 * Before a robot calls somebody else out.
 *
 * The slowest of its moves, so the humans at the table normally get the call. A
 * robot that caught instantly would turn a social rule into a tax.
 */
export const BOT_CATCH_MIN_MS = 2_200;
export const BOT_CATCH_MAX_MS = 4_000;

/** Before a robot answers an open +3, which freezes every other seat. */
export const BOT_ANSWER_MIN_MS = 500;
export const BOT_ANSWER_MAX_MS = 1_200;

/**
 * How long the table waits for a robot before the host passes the seat itself.
 *
 * A robot cannot be absent, so none of the seat machinery would ever rescue a
 * table stuck on one — and a suspended tab, a throttled timer or a bug in the
 * driver would stall the round with nothing to explain it. This is the backstop:
 * comfortably longer than any robot pause, short enough to be survivable.
 */
export const BOT_STALL_MS = 15_000;

/**
 * How long a seat has to be away before a robot may play it, when the table has
 * asked for that.
 *
 * Longer than both absent-turn graces on purpose: a blip is still answered by the
 * free skip that costs the absent player nothing, and only a real absence — three
 * orbits of skipping, by which point the round has stopped being a game — brings a
 * robot in. Far shorter than {@link SEAT_GRACE_MS}, because playing the seat is
 * what makes holding it worth anything.
 */
export const STAND_IN_ABSENT_MS = 45_000;

/**
 * How long a seat that is *present* but silent is waited on before a robot plays it.
 *
 * Longer than {@link IDLE_TURN_NUDGE_MS}, so the table gets to nudge a distracted
 * player before anything is done for them, and long enough that thinking hard
 * about a hand is never mistaken for having walked away. Measured from the last
 * thing that seat actually asked for — never from a heartbeat, which a phone in a
 * pocket answers perfectly.
 */
export const STAND_IN_IDLE_MS = 90_000;

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
