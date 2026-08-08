/**
 * Every deadline in the system, in one place, shared by the client and the room.
 *
 * One file, imported by both sides — the app bundle and the worker — so a number
 * that governs a countdown a player is shown and the timer that enforces it cannot
 * be two numbers. The rules that generate them:
 *
 * 1. **One authority per deadline.** Anything about the lifetime of a *seat* is the
 *    room's to decide, travels in the lobby snapshot, and is *derived* by the client
 *    — never re-declared. Two constants that have to agree eventually will not; one
 *    constant plus a subtraction cannot disagree.
 * 2. **A "give up" deadline must exceed the other side's "keep trying" deadline** for
 *    the same resource by the worst realistic recovery time: a 40 s WiFi/cellular
 *    handover plus one backoff round.
 * 3. **Nothing terminal is decided from a single failed attempt or a single timer
 *    expiry.**
 *
 * A whole family of constants used to live here and no longer does, because the
 * thing they measured has gone. Presence used to be *inferred* by one browser about
 * another, from unanswered probes: hence a probe cadence, a busy cadence, a count of
 * misses before "unstable", another before "silent", a floor under that derived from
 * ICE consent freshness, and a deadline for giving up on a channel. The room is told
 * when a socket closes, by the runtime, as it happens. An observation replaced the
 * entire apparatus.
 */

/**
 * How often a client asks its socket to prove it is alive.
 *
 * Answered by the Cloudflare runtime's auto-responder without waking the room, so
 * the cadence costs nothing but bytes. Fifteen seconds rather than five: a faster
 * cadence never lets a cellular modem reach its idle state, and a turn-based card
 * game does not need sub-second failure detection. The bytes are irrelevant; the
 * radio is not.
 */
export const PROBE_INTERVAL_IDLE_MS = 15_000;

/**
 * Deadline for the liveness probe fired after a wake or a late tick.
 *
 * Deliberately short: a tab that just woke needs an answer now, not a grace
 * period.
 */
export const PROBE_DEADLINE_MS = 3_000;

/**
 * Socket budget, first attempt versus later ones.
 *
 * Short for the attempt a player is actively watching, longer for the ones that
 * happen while they are waiting to get back in.
 */
export const CONNECT_TIMEOUT_FIRST_MS = 8_000;
export const CONNECT_TIMEOUT_RETRY_MS = 20_000;

/** Join handshake budget. Must exceed the room's own turnaround, and is not terminal. */
export const JOIN_TIMEOUT_MS = 15_000;

/**
 * Reconnection backoff, in seconds: 0, 1, 2, 5, 10, 20, 30.
 *
 * The first attempt is immediate because the thing that triggered it — a wake, an
 * `online` event, a socket close — is new information. The 30 s cap keeps a quiet
 * ceiling on how hard a room full of phones hammers the room.
 */
export const RECONNECT_BACKOFF_MS = [0, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

/** Proportional jitter applied to every backoff delay, so peers do not return in lockstep. */
export const BACKOFF_JITTER = 0.3;

/** Grace for a seat that drops *before* the game starts. */
export const LOBBY_GRACE_MS = 30_000;

/**
 * How long a seat is held mid-game before the table may vacate it.
 *
 * Must exceed the worst realistic recovery (rule 2 above) with margin. This is the
 * room's number and it goes on the wire, so the countdown a player sees is never a
 * promise their own timer will break.
 */
export const SEAT_GRACE_MS = 300_000;

/** How much sooner than the room's grace a client stops trying, so it never races the vacate. */
export const RECONNECT_DEADLINE_MARGIN_MS = 30_000;

/**
 * Before skipping the turn of a player whose socket is provably closed.
 *
 * Short on purpose. The room already *knows* the socket is gone, so waiting learns
 * nothing — and a pass costs the seat exactly what the turn would have cost anybody
 * who took the pile, which is what makes a short window affordable. It is the price
 * of the turn, not a penalty for the disconnection.
 *
 * There used to be a second, longer grace for a player who was merely *unstable*.
 * That state existed because presence was guessed at; it is not, so there is one
 * grace and it applies to the one thing that can now be true.
 */
export const ABSENT_TURN_GRACE_CLOSED_MS = 12_000;

/**
 * A pending skip is called off if the seat tried to rejoin this recently.
 *
 * An observed reconnection attempt is far stronger evidence that somebody is
 * coming back than silence is that they are not, and it costs nothing to record.
 */
export const RESUME_ATTEMPT_SUPPRESSES_SKIP_MS = 20_000;

/**
 * How long one submitted move keeps the table locked with no answer.
 *
 * 5 s was shorter than a single connection attempt, so any hiccup released the lock
 * and invited a second tap. This is only a backstop: the lock is released by an
 * explicit acknowledgement.
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
 * Thirty milliseconds sat here first — barely more than a frame — on the theory
 * that the window had only to settle that ordering. It did not, because the gap is
 * not one frame wide: the play has to reach the room, the new hand has to come back,
 * the declare button has to appear where nothing was a moment ago, and only then can
 * a thumb start moving to it. An opponent's button is already on screen and already
 * under a finger. A window narrower than that difference hands every last card to
 * whoever was watching rather than to whoever was playing.
 *
 * Three hundred milliseconds: a round trip plus the beginning of a reach, and still
 * inside the quarter-second a tap of one's own reads as instant. It is not enough to
 * make the button feel dead — the earlier quarter-second complaint was about a window
 * that also had nothing behind it to cover — and a genuinely silent player stays
 * exposed for as long as they stay silent either way.
 */
export const LAST_CARD_GRACE_MS = 300;

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
 * decision has already been made — so this stays well under a think.
 *
 * It has a floor it may not go under, and 260 ms was below it. A card played by
 * somebody else flies for `PLAY_REMOTE_MS` (240 ms), so a pause that short put
 * the next card in the air as the previous one landed: the run read as one
 * blur, and past `CATCH_UP_LAG` beats the view gave up describing it at all.
 * The lower bound is now the flight plus enough still air to see what landed,
 * which is the whole point of pausing between cards rather than sending the
 * sequence in one message.
 */
export const BOT_SEQUENCE_MIN_MS = 620;
export const BOT_SEQUENCE_MAX_MS = 900;

/**
 * Before a robot declares its own last card.
 *
 * A second or two sat here first, on the theory that a catchable robot is a fairer
 * robot. It was not a window, it was a guarantee: a robot reaching one card was
 * caught every single time by whoever happened to be looking, because a human hand
 * reaches a button in a fraction of that. The rule stopped being something the
 * table enforced against a robot and became something the table farmed.
 *
 * So: about as long as a person takes to tap the button they were already reaching
 * for. Still jittered, and still from the room's seeded stream, so that two robots
 * that reach their last card on the same beat do not shout in lockstep — and still
 * a real window, because the bottom of the range is not the top.
 */
export const BOT_DECLARE_MIN_MS = 0;
export const BOT_DECLARE_MAX_MS = 100;

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
 * How long the table waits for a robot before the room passes the seat itself.
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
 * Longer than both absent-turn graces on purpose: a blip is still answered by a
 * passed turn, which costs the seat a card and no more, and only a real absence —
 * three orbits of that, by which point the round has stopped being a game — brings
 * a robot in. Far shorter than {@link SEAT_GRACE_MS}, because playing the seat is
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

/**
 * The client's own give-up deadline, derived from the room's seat grace so the two
 * can never contradict each other.
 */
export function reconnectDeadlineMs(seatGraceMs: number): number {
  return Math.max(seatGraceMs - RECONNECT_DEADLINE_MARGIN_MS, RECONNECT_DEADLINE_MARGIN_MS);
}
