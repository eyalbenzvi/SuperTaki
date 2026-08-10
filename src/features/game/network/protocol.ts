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
 *
 * 6 — the room is the authority. There is no host peer to address, no host
 * generation to follow and no room to hand over, so `hostPeerId`, `generation`,
 * `handoffOffer` and `handoffAccepted` are gone; `hostClosed` becomes
 * `roomClosed`; `hostPlayerId` becomes `creatorPlayerId`, which names the seat
 * with the lobby buttons rather than the device running the game. The powers that
 * used to be method calls on a local object travel as `roomCommand`. Seat health
 * is what the runtime reports about a socket, so `'unstable'` — the state that
 * meant "we are inferring and unsure" — has nothing left to describe.
 *
 * 7 — a round has a *mode*. In `stairs` an empty hand is a step rather than a win,
 * so two peers on either side of this disagree about the single most important
 * thing at a table: whether the round is over. A stale tab would announce a winner
 * and then watch the game carry on without it, which is precisely what the gate
 * exists to prevent. The running score a room keeps across rounds rides along with
 * it.
 */
export const PROTOCOL_VERSION = 7;

/**
 * Versions this build will *accept*, as opposed to the one it sends.
 *
 * A single entry, and now permanently so. This list used to hold two, because
 * both sides of a table were browsers: the site is static and cached per browser,
 * so a player who reloaded fetched the new bundle while everybody else kept the
 * old one, and an exact-match gate would have ended the game on the reload the
 * resilience work existed to make survivable.
 *
 * That problem belonged to the topology. The room is one deployed worker, every
 * client talks only to it, and a stale tab meets a server that is always the
 * newer of the two — so the honest answer is "reload", which is exactly what the
 * gate says. Mixed-version tables are not a thing to be compatible with any more.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

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
/**
 * How a round is won: the ordinary game, or the staircase.
 *
 * Optional wherever it appears on the wire, and absent always means `classic` —
 * the game as it was before the modes existed. That is what keeps a snapshot
 * written by an older room readable, and it is the safe reading either way: a
 * client that assumes the staircase where there is none would refuse to believe a
 * round had been won.
 */
const gameModeSchema = z.enum(['classic', 'stairs']);
/** Hands emptied so far, out of the eight a staircase has. */
const stairsStepSchema = z.number().int().min(0).max(8);

export const takiModeSchema = z.object({
  color: colorSchema,
  playerId: playerIdSchema,
  cardsPlayed: z.number().int().min(1).max(200),
  openedWithSuperTaki: z.boolean(),
  /*
   * Defaulted rather than required, because a table can be mid-sequence when a
   * new room ships. `false` is the safe reading of a snapshot that predates the
   * field: it refuses a colour change the sequence might have allowed, where
   * `true` would offer one it might not.
   */
  takisOnly: z.boolean().default(false),
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
  /** How this round is won; see {@link gameModeSchema}. */
  mode: gameModeSchema.optional(),
  players: z
    .array(
      z.object({
        id: playerIdSchema,
        name: displayNameSchema,
        cardCount: z.number().int().min(0).max(200),
        /**
         * How many hands this seat has emptied, in a stairs round.
         *
         * Absent in a classic round rather than nought, so a screen cannot draw a
         * staircase for a table that is not playing one.
         */
        stairsStep: stairsStepSchema.optional(),
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
    type: z.literal('stairsAdvanced'),
    playerId: playerIdSchema,
    /** The step just finished, so never nought and never the eighth — that is a win. */
    stage: z.number().int().min(1).max(7),
    dealt: z.number().int().min(0).max(8),
  }),
  z.object({
    type: z.literal('turnSkipped'),
    playerId: playerIdSchema,
    drew: z.number().int().min(0).max(200),
  }),
  z.object({ type: z.literal('playerLeft'), playerId: playerIdSchema }),
  z.object({ type: z.literal('roundAbandoned') }),
]);

/**
 * A seat's link quality, as the room can actually observe it.
 *
 * Two states, not three. `'unstable'` existed because the authority was another
 * browser and had to *infer* presence from unanswered probes — so it needed a word
 * for "we are counting missed pings and are not sure yet". The room is told when a
 * socket closes, by the runtime, as it happens. There is nothing left to be unsure
 * about, and a state that only ever meant uncertainty has nothing to describe.
 */
export const connectionHealthSchema = z.enum(['connected', 'disconnected']);
export type ConnectionHealth = z.infer<typeof connectionHealthSchema>;

export const lobbyPlayerSchema = z.object({
  id: playerIdSchema,
  name: displayNameSchema,
  /** Whether this seat holds the lobby buttons. Not an authority; see `creatorPlayerId`. */
  isCreator: z.boolean(),
  health: connectionHealthSchema,
  /** Seat order; stable for the lifetime of the room. */
  seat: z.number().int().min(0).max(5),
  /**
   * When this seat went quiet, on the *room's* clock, paired with the snapshot's
   * `sentAt` so a client can work out its own offset once.
   *
   * A pre-computed duration was the obvious shape and the wrong one: it is stale
   * the moment it is sent, and a live countdown would force a full lobby
   * broadcast — and a re-render of the whole table — on every snapshot.
   */
  absentSince: z.number().int().min(0).optional(),
  /** True once this seat has left the round for good. */
  left: z.boolean().optional(),
  /** A robot seat: there is no device behind it, and never will be. */
  bot: z.boolean().optional(),
  /** A robot is playing this human's seat while nobody is answering for it. */
  standIn: z.boolean().optional(),
  /**
   * A robot played this seat at some point in the round that just ended.
   *
   * Kept separate from `standIn`, which is about right now: a round decided partly by
   * a robot reads differently from one that was not, and by the time the standings are
   * up the player is usually back — so the live flag would have cleared.
   */
  robotPlayed: z.boolean().optional(),
  /**
   * Rounds this seat has won since the room opened.
   *
   * The whole of the scoring: wins, not cards. Counting the cards left in everybody
   * else's hands would make the score a measure of how badly the losers lost, which
   * is a different game from the one being played — and it would need a rule for an
   * abandoned round, where nobody lost anything.
   *
   * It belongs to the *seat*, so it lives exactly as long as the seat does: a room
   * that closes takes every score with it, and a player who leaves for good and
   * comes back arrives on nought. Optional on the wire, and absent reads as nought,
   * so a snapshot from a room that predates the score still parses.
   */
  wins: z.number().int().min(0).max(10_000).optional(),
});

export const lobbySnapshotSchema = z.object({
  roomCode: z.string().min(3).max(32),
  /**
   * The seat that holds the lobby buttons: start the game, set the size, remove
   * somebody, seat a robot.
   *
   * Emphatically not an authority. It used to be `hostPlayerId` and it named the
   * device the whole game was running on; it now names a seat like any other, whose
   * only privilege is over the lobby. If that seat leaves the room the powers pass
   * to the lowest-numbered remaining one, so a table can always be started.
   */
  creatorPlayerId: playerIdSchema,
  maxPlayers: z.number().int().min(2).max(6),
  phase: z.enum(['lobby', 'inGame', 'finished']),
  players: z.array(lobbyPlayerSchema).max(6).readonly(),
  /** Table language the room suggests; clients may override locally. */
  tableLanguage: z.enum(['he', 'en']),
  /**
   * How the *next* round will be won, chosen when the table is set up.
   *
   * On the wire because it is a fact about the table every player is entitled to
   * know before the deal, not only the seat that chose it — and because a round in
   * play carries its own mode in the game state, which this must never contradict.
   */
  gameMode: gameModeSchema.optional(),
  /** The room's clock when this snapshot was built. */
  sentAt: z.number().int().min(0),
  /**
   * How long the room will hold an absent seat.
   *
   * On the wire because there must be exactly one authority for it. The client
   * derives its own give-up deadline from this rather than declaring a second
   * number, so the countdown a player is shown can never be contradicted by the
   * timer running underneath it.
   */
  seatGraceMs: z.number().int().min(0),
  /** Whether the table is paused, and who asked. */
  pausedBy: playerIdSchema.nullable(),
  /** Who the table is waiting for, and why — so no screen has to guess. */
  waitingFor: playerIdSchema.nullable(),
  waitingReason: z.enum(['turn', 'absent', 'breaker', 'paused']).nullable(),
  /** Room clock at which the table started waiting, paired with `sentAt`. */
  waitingSince: z.number().int().min(0).nullable(),
  /** Players who have voted to abandon the round. */
  abandonVotes: z.array(playerIdSchema).max(6).readonly(),
  /**
   * Whether this table lets a robot play a seat nobody is answering for.
   *
   * On the wire because it is a fact about the room every player is entitled to
   * know, not only the seat that set it.
   */
  standInEnabled: z.boolean(),
});

export type LobbySnapshot = z.infer<typeof lobbySnapshotSchema>;
export type LobbyPlayer = z.infer<typeof lobbyPlayerSchema>;

/** Action a client asks for. The room attaches the authenticated player id. */
export const gameActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('playCard'),
    cardId: cardIdSchema,
    chosenColor: colorSchema.optional(),
    /*
     * "Last card!" shouted with the card rather than after it. Optional, so an
     * older client that never sends it is unchanged, and honoured by the engine
     * only when the play really does leave one card in hand.
     */
    declareLastCard: z.boolean().optional(),
  }),
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
  /**
   * Asked to *create* a room that already has players in it.
   *
   * A room code collision, which used to surface as the relay refusing a peer id
   * claim. The client draws another six digits and tries again, exactly as before —
   * there is simply no id to claim any more, so the room itself answers.
   */
  'roomTaken',
]);
export type JoinRejectionReason = z.infer<typeof joinRejectionReasonSchema>;

/**
 * Why the room stopped.
 *
 * Both of these are terminal, and that is the whole difference from the four
 * reasons this replaced. A host could stop serving without the room ending —
 * reloading, or handing over — so a client had to tell a goodbye from a
 * see-you-in-a-moment and hold its seat through the second. The room does not
 * reload and does not move: if it says it is closed, it is.
 */
export const roomClosedReasonSchema = z.enum(['roomClosed']);
export const kickReasonSchema = z.enum(['removedByCreator', 'duplicateConnection']);

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

/**
 * The lobby powers, as messages.
 *
 * Every one of these used to be a method call on the local `HostSession`, which is
 * why they were never on the wire: the person with the buttons was, by
 * construction, the person running the game. Now they travel, and the room
 * authorises each one against `creatorPlayerId` — so the buttons follow a
 * credential rather than following whichever device happens to be serving.
 *
 * One message type rather than ten keeps the top-level union readable and, more to
 * the point, keeps the authorisation check in exactly one place.
 */
export const roomCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('startGame') }),
  z.object({ type: z.literal('setMaxPlayers'), maxPlayers: z.number().int().min(2).max(6) }),
  z.object({ type: z.literal('setTableLanguage'), language: z.enum(['he', 'en']) }),
  /** Picks the mode for the next round. Refused once cards are dealt. */
  z.object({ type: z.literal('setGameMode'), mode: gameModeSchema }),
  z.object({ type: z.literal('kickPlayer'), playerId: playerIdSchema }),
  z.object({ type: z.literal('addBot') }),
  z.object({ type: z.literal('setStandInEnabled'), enabled: z.boolean() }),
  z.object({ type: z.literal('standInNow'), playerId: playerIdSchema }),
  z.object({ type: z.literal('stopStandIn'), playerId: playerIdSchema }),
  /** Passes the turn of a seat that is not there. Never reaches the engine from a client. */
  z.object({ type: z.literal('skipAbsentTurn'), playerId: playerIdSchema }),
  z.object({ type: z.literal('removeFromRound'), playerId: playerIdSchema }),
]);
export type RoomCommand = z.infer<typeof roomCommandSchema>;

/** Messages a client may send to the room. */
export const clientMessageSchema = z.discriminatedUnion('type', [
  message(
    'joinRequest',
    z.object({
      displayName: displayNameSchema,
      /**
       * Present on the first connection to a room that does not exist yet.
       *
       * The room accepts it only while it has no seats; otherwise the answer is
       * `roomTaken` and the client draws another code. This is what replaces
       * claiming a peer id derived from the room code: the collision check moved
       * from the relay's id table to the room's own emptiness.
       */
      create: z
        .object({
          maxPlayers: z.number().int().min(2).max(6),
          tableLanguage: z.enum(['he', 'en']),
          /** Chosen in the create-a-table settings; `classic` when a client omits it. */
          gameMode: gameModeSchema.optional(),
        })
        .optional(),
    }),
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
  message('playAgainVote', z.object({ agree: z.boolean() })),
  /** Asks the table to hold, out loud, so nobody has to race a countdown. */
  message('pauseRequest', z.object({ paused: z.boolean() })),
  /** Votes to end a round that cannot sensibly continue. */
  message('abandonVote', z.object({ agree: z.boolean() })),
  /** Nudges a player who is connected but not looking. */
  message('nudge', z.object({ targetPlayerId: playerIdSchema })),
  /** A lobby power. Refused unless it comes from the seat that holds them. */
  message('roomCommand', z.object({ command: roomCommandSchema })),
]);

/** Messages the room may send to a client. */
export const roomMessageSchema = z.discriminatedUnion('type', [
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
  message('roomClosed', z.object({ reason: roomClosedReasonSchema })),
  message(
    'playAgainState',
    z.object({ agreed: z.array(playerIdSchema).max(6).readonly(), required: z.number().int().min(0).max(6) }),
  ),
  /** Somebody asked the table to wait. */
  message('paused', z.object({ pausedBy: playerIdSchema.nullable() })),
  /** Somebody nudged this player: it is their turn and they may not have noticed. */
  message('nudged', z.object({ fromPlayerId: playerIdSchema })),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type RoomMessage = z.infer<typeof roomMessageSchema>;
export type AnyMessage = ClientMessage | RoomMessage;
export type ClientMessageType = ClientMessage['type'];
export type RoomMessageType = RoomMessage['type'];

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

/** Validates a message received by the room (i.e. sent by a client). */
export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  return parseWith(clientMessageSchema, raw);
}

/** Validates a message received by a client (i.e. sent by the room). */
export function parseRoomMessage(raw: unknown): ParseResult<RoomMessage> {
  return parseWith(roomMessageSchema, raw);
}
