import { z } from 'zod';
import { DISPLAY_NAME_MAX_LENGTH } from '../../../lib/sanitize.ts';
import type { Card } from '../engine/cards.ts';
import { REJECTION_CODES } from '../engine/state.ts';

/**
 * Wire protocol for Color Rush.
 *
 * Every message is validated at runtime before it can influence any state.
 * See `docs/protocol.md` for the human-readable specification.
 */

/** Bumped on any breaking change to message shapes or semantics. */
export const PROTOCOL_VERSION = 1;

/** Hard cap on a single decoded message, to bound memory from a hostile peer. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

const colorSchema = z.enum(['red', 'blue', 'green', 'yellow']);
const cardIdSchema = z.string().min(1).max(40);
const numberValueSchema = z.union([
  z.literal(1),
  z.literal(2),
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
  z.object({ id: cardIdSchema, kind: z.literal('direction'), color: colorSchema }),
  z.object({ id: cardIdSchema, kind: z.literal('taki'), color: colorSchema }),
  z.object({ id: cardIdSchema, kind: z.literal('colorChange') }),
  z.object({ id: cardIdSchema, kind: z.literal('superTaki') }),
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
  phase: z.enum(['playing', 'finished']),
  players: z
    .array(
      z.object({
        id: playerIdSchema,
        name: displayNameSchema,
        cardCount: z.number().int().min(0).max(200),
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
    count: z.number().int().min(1).max(10),
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
  z.object({ type: z.literal('directionChanged'), direction: directionSchema }),
  z.object({ type: z.literal('extraTurn'), playerId: playerIdSchema }),
  z.object({ type: z.literal('turnChanged'), playerId: playerIdSchema }),
  z.object({ type: z.literal('drawPileRecycled'), count: z.number().int().min(0).max(200) }),
  z.object({ type: z.literal('drawPileExhausted') }),
  z.object({ type: z.literal('playerWon'), playerId: playerIdSchema }),
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
});

export type LobbySnapshot = z.infer<typeof lobbySnapshotSchema>;
export type LobbyPlayer = z.infer<typeof lobbyPlayerSchema>;

/** Action a client asks for. The host attaches the authenticated player id. */
export const gameActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('playCard'), cardId: cardIdSchema, chosenColor: colorSchema.optional() }),
  z.object({ type: z.literal('drawCard') }),
  z.object({ type: z.literal('closeTaki') }),
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

export const hostClosedReasonSchema = z.enum(['hostLeft', 'roomReset']);
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

/** Messages a client may send to the host. */
export const clientMessageSchema = z.discriminatedUnion('type', [
  message(
    'joinRequest',
    z.object({ displayName: displayNameSchema, wantsSpectator: z.boolean().optional() }),
  ),
  message('resumeRequest', z.object({ playerId: playerIdSchema, resumeToken: resumeTokenSchema })),
  message('action', z.object({ action: gameActionSchema })),
  message('leave', z.object({})),
  message('ping', z.object({ nonce: z.string().min(1).max(64) })),
  message('pong', z.object({ nonce: z.string().min(1).max(64) })),
  message('playAgainVote', z.object({ agree: z.boolean() })),
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
  message('kicked', z.object({ reason: kickReasonSchema })),
  message('hostClosed', z.object({ reason: hostClosedReasonSchema })),
  message('ping', z.object({ nonce: z.string().min(1).max(64) })),
  message('pong', z.object({ nonce: z.string().min(1).max(64) })),
  message(
    'playAgainState',
    z.object({ agreed: z.array(playerIdSchema).max(6).readonly(), required: z.number().int().min(0).max(6) }),
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
  if (preflight.data.protocolVersion !== PROTOCOL_VERSION) {
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
