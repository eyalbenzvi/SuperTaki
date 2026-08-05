import { z } from 'zod';
import { DISPLAY_NAME_MAX_LENGTH } from '../../../lib/sanitize.ts';

/*
 * Zod compiles validators with `new Function` when it can, and probes for that
 * with `Function('')`. Our Content Security Policy has no `'unsafe-eval'`, so
 * the probe throws, Zod falls back to its interpreted path, and the browser
 * logs a CSP violation on every load. Declaring `jitless` skips the probe: same
 * behaviour we already get, without weakening the policy or the console noise.
 */
z.config({ jitless: true });
import type { Card } from '../engine/cards.ts';
import { REJECTION_CODES } from '../engine/state.ts';

/**
 * Wire protocol for Super Taki.
 *
 * Every message is validated at runtime before it can influence any state.
 * See `docs/protocol.md` for the human-readable specification.
 */

/**
 * Bumped on any breaking change to message shapes or semantics.
 *
 * 3 — the plain number 2 left the deck; "last card" became a declaration anyone
 * can call out; Taki on Taki changes the colour of an open sequence; and a +3
 * Breaker with nothing to break is a legal, expensive card.
 *
 * 4 — resilience: acknowledged actions, seats that can be absent or gone, host
 * restarts and handover, table pauses.
 *
 * 5 — a King answers an open +2 run and cancels it, with a `drawRunCancelled`
 * event to say so. A rule, not a field: two peers on different sides of this
 * disagree about which cards are legal, which is exactly what the version gate
 * exists to catch.
 */
export const PROTOCOL_VERSION = 5;

/**
 * Versions this build will *accept*, as opposed to the one it sends.
 *
 * This matters more than it looks. The site is static and cached per browser, so
 * when one player reloads — which is the very thing the resilience work exists to
 * make survivable — they fetch the new bundle while everybody else keeps the old
 * one. With a single exact version, that reload would answer `protocolMismatch`
 * to the whole table and end the game outright: a release that defeats its own
 * purpose on the way in.
 *
 * Every field added in 4 is optional, Zod strips the ones a version-3 reader does
 * not know about, and a mixed 3/4 table loses the new behaviour rather than the
 * game. Version 5 is the first bump that cannot be carried that way: it changes
 * which cards are legal, so a table split across it would have two peers refusing
 * each other's moves and blaming the game. A stale tab is told to reload instead,
 * which is the outcome the gate is for.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [5];

/** Hard cap on a single decoded message, to bound memory from a hostile peer. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

const colorSchema = z.enum(['red', 'blue', 'green', 'yellow']);
const cardIdSchema = z.string().min(1).max(40);
// No plain 2: the only 2 in the deck is the +2. See `NUMBER_VALUES`.
const numberValueSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
]);

export const cardSchema = z.discriminatedUnion('kind', [
  z.object({ id: cardIdSchema, kind: z.literal('number'), color: colorSchema, value: numberValueSchema }),
  z.object({ id: cardIdSchema, kind: z.literal('stop'), color: colorSchema }),
  z.object({ id: cardIdSchema, kind: z.literal('plus'), color: colorSchema }),
  z.object({ id: cardIdSchema, kind: z.literal('plusTwo'), color: colorSchema }),
  z.object({ id: cardIdSchema, kind: z.literal('direction'), color: colorSchema }),
  z.object({ id: cardIdSchema, kind: z.literal('taki'), color: colorSchema }),
  z.object({ id: cardIdSchema, kind: z.literal('colorChange') }),
  z.object({ id: cardIdSchema, kind: z.literal('superTaki') }),
  z.object({ id: cardIdSchema, kind: z.literal('king') }),
  z.object({ id: cardIdSchema, kind: z.literal('plusThree') }),
  z.object({ id: cardIdSchema, kind: z.literal('breakPlusThree') }),
]);

// Compile-time proof that the schema and the engine model cannot drift apart.
const _cardSchemaMatchesEngine: z.ZodType<Card> = cardSchema;
void _cardSchemaMatchesEngine;

const playerIdSchema = z.string().min(1).max(64);
const displayNameSchema = z.string().min(1).max(DISPLAY_NAME_MAX_LENGTH);
const resumeTokenSchema = z.string().min(8).max(64);
const directionSchema = z.union([z.literal(1), z.literal(-1)]);
const rejectionCodeSchema = z.enum(REJECTION_CODES);

export const takiModeSchema = z.object({
  color: colorSchema,
  playerId: playerIdSchema,
  cardsPlayed: z.number().int().min(1).max(200),
  openedWithSuperTaki: z.boolean(),
});

export const publicGameStateSchema = z.object({
  version: z.number().int().nonnegative(),
  /**
   * Turn counter, used by a client to ask "is my move still meant for the table I
   * was looking at?". Optional so a version-3 peer stays readable.
   */
  turnSeq: z.number().int().nonnegative().optional(),
  phase: z.enum(['playing', 'finished']),
  endReason: z.enum(['won', 'abandoned']).optional(),
  players: z
    .array(
      z.object({
        id: playerIdSchema,
        name: displayNameSchema,
        cardCount: z.number().int().min(0).max(200),
        /**
         * True for a seat that has left the round for good.
         *
         * Because they are marked rather than deleted, the array never shrinks
         * below the two players this schema requires — which is what stops the
         * final broadcast of a round that ran out of players from being
         * unparseable to everybody receiving it.
         */
        left: z.boolean().optional(),
      }),
    )
    .min(2)
    .max(6)
    .readonly(),
  drawPileCount: z.number().int().min(0).max(200),
  discardTop: cardSchema.nullable(),
  discardCount: z.number().int().min(0).max(200),
  activeColor: colorSchema,
  direction: directionSchema,
  currentPlayerId: playerIdSchema.nullable(),
  takiMode: takiModeSchema.nullable(),
  pendingPlus: z.boolean(),
  pendingDraw: z.number().int().min(0).max(200),
  freePlay: z.boolean(),
  plusThree: z.object({ playerId: playerIdSchema }).nullable(),
  declaredLastCard: z.array(playerIdSchema).max(6).readonly(),
  winnerId: playerIdSchema.nullable(),
});

export const privateHandSchema = z.object({
  version: z.number().int().nonnegative(),
  playerId: playerIdSchema,
  cards: z.array(cardSchema).max(200).readonly(),
});

export const gameEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gameStarted'), firstPlayerId: playerIdSchema, activeColor: colorSchema }),
  z.object({
    type: z.literal('cardPlayed'),
    playerId: playerIdSchema,
    card: cardSchema,
    resultingColor: colorSchema,
  }),
  z.object({
    type: z.literal('cardDrawn'),
    playerId: playerIdSchema,
    count: z.number().int().min(1).max(200),
  }),
  z.object({
    type: z.literal('takiOpened'),
    playerId: playerIdSchema,
    color: colorSchema,
    superTaki: z.boolean(),
  }),
  z.object({
    type: z.literal('takiClosed'),
    playerId: playerIdSchema,
    cardsPlayed: z.number().int().min(1).max(200),
  }),
  z.object({ type: z.literal('takiColorChanged'), playerId: playerIdSchema, color: colorSchema }),
  z.object({ type: z.literal('colorChosen'), playerId: playerIdSchema, color: colorSchema }),
  z.object({ type: z.literal('playerSkipped'), playerId: playerIdSchema }),
  z.object({
    type: z.literal('drawStacked'),
    playerId: playerIdSchema,
    total: z.number().int().min(2).max(200),
  }),
  z.object({
    type: z.literal('drawRunCancelled'),
    playerId: playerIdSchema,
    cancelled: z.number().int().min(2).max(200),
  }),
  z.object({ type: z.literal('plusThreePlayed'), playerId: playerIdSchema }),
  z.object({
    type: z.literal('plusThreeBroken'),
    playerId: playerIdSchema,
    targetId: playerIdSchema,
  }),
  z.object({ type: z.literal('lastCardDeclared'), playerId: playerIdSchema }),
  z.object({
    type: z.literal('lastCardCaught'),
    playerId: playerIdSchema,
    caughtById: playerIdSchema,
    penalty: z.number().int().min(0).max(200),
  }),
  z.object({
    type: z.literal('breakerSpent'),
    playerId: playerIdSchema,
    penalty: z.number().int().min(0).max(200),
  }),
  z.object({ type: z.literal('directionChanged'), direction: directionSchema }),
  z.object({ type: z.literal('extraTurn'), playerId: playerIdSchema }),
  z.object({ type: z.literal('turnChanged'), playerId: playerIdSchema }),
  z.object({ type: z.literal('drawPileRecycled'), count: z.number().int().min(0).max(200) }),
  z.object({ type: z.literal('drawPileExhausted') }),
  z.object({ type: z.literal('playerWon'), playerId: playerIdSchema }),
  z.object({
    type: z.literal('turnSkipped'),
    playerId: playerIdSchema,
    drew: z.number().int().min(0).max(200),
  }),
  z.object({ type: z.literal('playerLeft'), playerId: playerIdSchema }),
  z.object({ type: z.literal('roundAbandoned') }),
]);

export const connectionHealthSchema = z.enum(['connected', 'unstable', 'disconnected']);
export type ConnectionHealth = z.infer<typeof connectionHealthSchema>;

export const lobbyPlayerSchema = z.object({
  id: playerIdSchema,
  name: displayNameSchema,
  isHost: z.boolean(),
  health: connectionHealthSchema,
  /** Seat order; stable for the lifetime of the room. */
  seat: z.number().int().min(0).max(5),
  /**
   * When this seat went quiet, on the *host's* clock, paired with the snapshot's
   * `sentAt` so a client can work out its own offset once.
   *
   * A pre-computed duration was the obvious shape and the wrong one: it is stale
   * the moment it is sent, and a live countdown would force a full lobby
   * broadcast — and a re-render of the whole table — on every heartbeat.
   */
  absentSince: z.number().int().min(0).optional(),
  /** True once this seat has left the round for good. */
  left: z.boolean().optional(),
});

export const lobbySnapshotSchema = z.object({
  roomCode: z.string().min(3).max(32),
  hostPeerId: z.string().min(1).max(64),
  hostPlayerId: playerIdSchema,
  maxPlayers: z.number().int().min(2).max(6),
  phase: z.enum(['lobby', 'inGame', 'finished']),
  players: z.array(lobbyPlayerSchema).max(6).readonly(),
  /** Table language the host suggests; clients may override locally. */
  tableLanguage: z.enum(['he', 'en']),
  /** The host's clock when this snapshot was built. */
  sentAt: z.number().int().min(0).optional(),
  /**
   * How long the host will hold an absent seat.
   *
   * On the wire because there must be exactly one authority for it. The client
   * derives its own give-up deadline from this rather than declaring a second
   * number, so the countdown a player is shown can never be contradicted by the
   * timer running underneath it.
   */
  seatGraceMs: z.number().int().min(0).optional(),
  /** Whether the table is paused, and who asked. */
  pausedBy: playerIdSchema.nullish(),
  /** Who the table is waiting for, and why — so no screen has to guess. */
  waitingFor: playerIdSchema.nullish(),
  waitingReason: z.enum(['turn', 'absent', 'breaker', 'paused']).nullish(),
  /** Host clock at which the table started waiting, paired with `sentAt`. */
  waitingSince: z.number().int().min(0).nullish(),
  /** Players who have voted to abandon the round. */
  abandonVotes: z.array(playerIdSchema).max(6).readonly().optional(),
  /** Host generation, so a client can follow a handover. */
  generation: z.number().int().min(0).max(16).optional(),
});

export type LobbySnapshot = z.infer<typeof lobbySnapshotSchema>;
export type LobbyPlayer = z.infer<typeof lobbyPlayerSchema>;

/** Action a client asks for. The host attaches the authenticated player id. */
export const gameActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('playCard'), cardId: cardIdSchema, chosenColor: colorSchema.optional() }),
  z.object({ type: z.literal('drawCard') }),
  z.object({ type: z.literal('closeTaki') }),
  z.object({ type: z.literal('passBreak') }),
  z.object({ type: z.literal('declareLastCard') }),
  z.object({ type: z.literal('catchLastCard'), targetId: playerIdSchema }),
]);
export type GameAction = z.infer<typeof gameActionSchema>;

export const joinRejectionReasonSchema = z.enum([
  'roomFull',
  'gameInProgress',
  'invalidName',
  'protocolMismatch',
  'unknownSeat',
  'invalidResumeToken',
  'roomClosed',
]);
export type JoinRejectionReason = z.infer<typeof joinRejectionReasonSchema>;

/**
 * Why the host stopped serving.
 *
 * `restarting` and `handoff` are the two that are *not* the end of anything: the
 * first means "reloading, hold your seat", the second "somebody else is taking
 * over, follow them". Without that distinction a client had no way to tell a
 * goodbye from a see-you-in-a-moment, and treated both as fatal.
 */
export const hostClosedReasonSchema = z.enum(['hostLeft', 'roomReset', 'restarting', 'handoff']);
export const kickReasonSchema = z.enum(['removedByHost', 'duplicateConnection']);

const envelopeShape = {
  protocolVersion: z.number().int().min(0).max(1000),
  id: z.string().min(1).max(64),
  roomId: z.string().min(3).max(32),
  senderPeerId: z.string().min(1).max(64),
  timestamp: z.number().int().min(0),
} as const;

/** Loose first pass used to read the version before full validation. */
export const envelopePreflightSchema = z.object({
  ...envelopeShape,
  type: z.string().min(1).max(40),
});

function message<TType extends string, TPayload extends z.ZodTypeAny>(type: TType, payload: TPayload) {
  return z.object({ ...envelopeShape, type: z.literal(type), payload });
}

/** Identifies one *intent*, stable across re-sends. */
const requestIdSchema = z.string().min(1).max(64);

/**
 * The turn a client believed was in play when it decided to move.
 *
 * Checked only for the moves that belong to a turn. It deliberately is *not*
 * checked for declaring last card, catching somebody who did not, or answering a
 * +3 — those are legal at any moment by design, they race each other on purpose,
 * and gating them on a turn would hand every tie to whoever broke the rule.
 */
const turnTokenSchema = z.object({
  currentPlayerId: playerIdSchema.nullable(),
  turnSeq: z.number().int().nonnegative(),
});

/** Messages a client may send to the host. */
export const clientMessageSchema = z.discriminatedUnion('type', [
  message(
    'joinRequest',
    z.object({ displayName: displayNameSchema, wantsSpectator: z.boolean().optional() }),
  ),
  message('resumeRequest', z.object({ playerId: playerIdSchema, resumeToken: resumeTokenSchema })),
  message(
    'action',
    z.object({
      action: gameActionSchema,
      /**
       * Minted once by the store and kept across re-sends.
       *
       * Not the envelope id, which is regenerated on every send and therefore
       * cannot match a replay — the one case it would need to.
       */
      requestId: requestIdSchema.optional(),
      turnToken: turnTokenSchema.optional(),
    }),
  ),
  message('leave', z.object({})),
  message('ping', z.object({ nonce: z.string().min(1).max(64) })),
  message('pong', z.object({ nonce: z.string().min(1).max(64) })),
  message('playAgainVote', z.object({ agree: z.boolean() })),
  /** Asks the table to hold, out loud, so nobody has to race a countdown. */
  message('pauseRequest', z.object({ paused: z.boolean() })),
  /** Votes to end a round that cannot sensibly continue. */
  message('abandonVote', z.object({ agree: z.boolean() })),
  /** Nudges a player who is connected but not looking. */
  message('nudge', z.object({ targetPlayerId: playerIdSchema })),
  /** The named successor confirms it can take the room over. */
  message('handoffAccepted', z.object({ generation: z.number().int().min(0).max(16) })),
]);

/** Messages the host may send to a client. */
export const hostMessageSchema = z.discriminatedUnion('type', [
  message(
    'joinAccepted',
    z.object({
      playerId: playerIdSchema,
      resumeToken: resumeTokenSchema,
      displayName: displayNameSchema,
      lobby: lobbySnapshotSchema,
    }),
  ),
  message('joinRejected', z.object({ reason: joinRejectionReasonSchema })),
  message('lobbyState', z.object({ lobby: lobbySnapshotSchema })),
  message('publicState', z.object({ state: publicGameStateSchema })),
  message('privateHand', z.object({ hand: privateHandSchema })),
  message(
    'gameEvents',
    z.object({
      version: z.number().int().nonnegative(),
      events: z.array(gameEventSchema).max(64).readonly(),
    }),
  ),
  message(
    'actionRejected',
    z.object({ code: rejectionCodeSchema, requestId: z.string().max(64).optional() }),
  ),
  /**
   * Confirms one specific intent was applied.
   *
   * An acknowledgement cannot be inferred from the state moving forward, because
   * in this game other players legally act out of turn — so a new snapshot may
   * have nothing to do with my move, and treating it as proof would let a lost
   * action look delivered. Hence an explicit answer carrying the request id.
   */
  message(
    'actionAccepted',
    z.object({ requestId: requestIdSchema, version: z.number().int().nonnegative() }),
  ),
  message('kicked', z.object({ reason: kickReasonSchema })),
  message(
    'hostClosed',
    z.object({
      reason: hostClosedReasonSchema,
      /** For a handover: where to find the new host. */
      successorPeerId: z.string().min(1).max(64).optional(),
      generation: z.number().int().min(0).max(16).optional(),
    }),
  ),
  message('ping', z.object({ nonce: z.string().min(1).max(64) })),
  message('pong', z.object({ nonce: z.string().min(1).max(64) })),
  message(
    'playAgainState',
    z.object({ agreed: z.array(playerIdSchema).max(6).readonly(), required: z.number().int().min(0).max(6) }),
  ),
  /** Somebody asked the table to wait. */
  message('paused', z.object({ pausedBy: playerIdSchema.nullable() })),
  /** Somebody nudged this player: it is their turn and they may not have noticed. */
  message('nudged', z.object({ fromPlayerId: playerIdSchema })),
  /**
   * Everything the named successor needs to keep the round going.
   *
   * Sent exactly once, at the moment of a voluntary handover — not continuously.
   * A per-commit snapshot would have been roughly a megabyte a round onto one
   * player's mobile data, and it only seemed necessary while the plan still
   * imagined taking over from a host that might be lying. A living host handing
   * over on an already-trusted channel needs no such apparatus.
   */
  message(
    'handoffOffer',
    z.object({
      generation: z.number().int().min(0).max(16),
      snapshot: z.unknown(),
    }),
  ),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type HostMessage = z.infer<typeof hostMessageSchema>;
export type AnyMessage = ClientMessage | HostMessage;
export type ClientMessageType = ClientMessage['type'];
export type HostMessageType = HostMessage['type'];

export type ParseFailure =
  | { readonly ok: false; readonly error: 'notAnObject' }
  | { readonly ok: false; readonly error: 'tooLarge' }
  | { readonly ok: false; readonly error: 'malformedEnvelope' }
  | { readonly ok: false; readonly error: 'protocolMismatch'; readonly received: number }
  | { readonly ok: false; readonly error: 'unknownType'; readonly received: string }
  | { readonly ok: false; readonly error: 'invalidPayload'; readonly issues: string[] };

export type ParseResult<T> = { readonly ok: true; readonly message: T } | ParseFailure;

function tooLarge(raw: unknown): boolean {
  try {
    return JSON.stringify(raw).length > MAX_MESSAGE_BYTES;
  } catch {
    return true;
  }
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'notAnObject' };
  }
  if (tooLarge(raw)) {
    return { ok: false, error: 'tooLarge' };
  }

  const preflight = envelopePreflightSchema.safeParse(raw);
  if (!preflight.success) {
    return { ok: false, error: 'malformedEnvelope' };
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(preflight.data.protocolVersion)) {
    return { ok: false, error: 'protocolMismatch', received: preflight.data.protocolVersion };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const known = parsed.error.issues.some((issue) => issue.path.length === 1 && issue.path[0] === 'type');
    if (known) {
      return { ok: false, error: 'unknownType', received: preflight.data.type };
    }
    return {
      ok: false,
      error: 'invalidPayload',
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  return { ok: true, message: parsed.data };
}

/** Validates a message received by the host (i.e. sent by a client). */
export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  return parseWith(clientMessageSchema, raw);
}

/** Validates a message received by a client (i.e. sent by the host). */
export function parseHostMessage(raw: unknown): ParseResult<HostMessage> {
  return parseWith(hostMessageSchema, raw);
}
