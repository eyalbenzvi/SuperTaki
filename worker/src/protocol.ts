/**
 * What is left of the relay's own wire protocol: almost nothing.
 *
 * The relay used to speak a second protocol underneath the game's — a hello with
 * a peer-id claim, then `open`/`accept`/`msg`/`close` frames routed between named
 * peers, plus `peerUp`/`peerDown`/`gone` presence. Its whole job was routing, and
 * once the room itself became the authority there was exactly one destination left
 * to route to. So the layer is gone and the socket *is* the session: a client
 * connects and immediately speaks the game protocol
 * (`src/features/game/network/protocol.ts`), which the room answers.
 *
 * That leaves one protocol version in the system rather than two, gated in one
 * place — the envelope's `protocolVersion`, checked by `parseClientMessage`. What
 * remains here are the concerns that belong to the socket rather than to the game:
 * which paths name a room, how large a frame may be, and how long an empty room is
 * remembered.
 */

/** Six digits, read out loud over a table. Also the Durable Object's name. */
export const ROOM_CODE_PATTERN = /^\d{6}$/;

/**
 * The liveness probe, and why it is a bare string rather than a game message.
 *
 * A phone coming out of sleep cannot tell a live socket from a half-open one, so
 * the client has to ask. It used to ask with a `ping` *message*, which the room
 * answered — and every one of those woke the Durable Object, on a cadence, for
 * every player, for the whole life of the room. That is precisely the bill
 * hibernation exists to avoid.
 *
 * These two strings are registered with `setWebSocketAutoResponse`, so the runtime
 * answers them itself while the object stays asleep. The room never sees a probe
 * and does not need to: it learns about a departure from the close event, which is
 * the runtime telling it rather than the room inferring.
 */
export const PROBE_REQUEST = 'ping';
export const PROBE_RESPONSE = 'pong';

/**
 * Ceiling on a single frame.
 *
 * The largest legitimate message is a public snapshot for six players plus a full
 * hand — a couple of kilobytes. This is generous by two orders of magnitude on
 * purpose: it is a memory bound against a hostile client, not a budget.
 *
 * The game protocol enforces its own, tighter limit (`MAX_MESSAGE_BYTES`, 64 KiB)
 * on the decoded message. This one is checked first, on the raw string, so a
 * megabyte of garbage is dropped without being parsed.
 */
export const MAX_FRAME_BYTES = 131_072;

/**
 * A room with nobody in it is forgotten after this long.
 *
 * It has to outlive every credential that could still come back to it, because a
 * resume token for a room that has been deleted is a dead end with no explanation.
 * Six hours covers an evening interrupted by dinner; past that the players have
 * gone to bed and the hands are not worth keeping.
 */
export const ROOM_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

/** Close codes surfaced to clients; 4xxx is the app-reserved range. */
export const CLOSE_BAD_FRAME = 4000;
/** A newer socket claimed this seat; this one is obsolete. */
export const CLOSE_SUPERSEDED = 4001;
/** The join was refused. The client has been told why in a `joinRejected`. */
export const CLOSE_REJECTED = 4003;
