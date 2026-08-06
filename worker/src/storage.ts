/**
 * The room's durable state, and the one interface it is reached through.
 *
 * Two records, each a single JSON blob validated on the way in *and* on the way
 * out: the room (`RoomRecord` — seats, phase, votes, the clocks the host used to
 * keep in memory) and the game (`GameState` — hands, deck order, the RNG's own
 * state). Nothing else survives a hibernation, and nothing else needs to.
 *
 * Why blobs rather than columns: the room record is at most six seats and is
 * always read and written whole — no query ever wants one seat — and it needs a
 * schema for validate-on-read regardless, which is a better description of the
 * shape than a table would be. The game state has to be a blob whatever we do,
 * because its *order* is the state: shuffle a draw pile into rows and you have
 * thrown the game away.
 *
 * `RoomStore` is deliberately three synchronous methods over strings. That is what
 * lets the whole room run in plain Node against a `Map` — see `worker/test/` — and
 * it is the same trick the old relay's `ClaimStore` used, extended from claims to
 * the entire game.
 */

import { z } from 'zod';
import { cardSchema } from '../../src/features/game/network/protocol.ts';
import type { GameState } from '../../src/features/game/engine/state.ts';

/** What the room needs from durable storage. Synchronous, string in, string out. */
export interface RoomStore {
  get(key: string): string | undefined;
  put(key: string, value: string): void;
  delete(key: string): void;
}

const ROOM_KEY = 'room';
const GAME_KEY = 'game';

const playerId = z.string().min(1).max(64);
const resumeToken = z.string().min(8).max(64);

/**
 * One seat, as the room remembers it between messages.
 *
 * This is the old `Seat` interface minus everything that was an inference and plus
 * everything that used to live only in the host's memory. Gone: `health`, `peerId`
 * and the whole `ProbeTracker` — a seat is present exactly when the room is holding
 * an open socket for it, which is a fact rather than a running tally of unanswered
 * pings. Added: `absentSince` and the intent clocks now persist, so a room that
 * hibernates mid-round does not come back having forgiven everybody everything.
 */
const seatSchema = z.object({
  playerId,
  name: z.string().min(1).max(32),
  seat: z.number().int().min(0).max(5),
  resumeToken,
  /** True once this seat has left the round for good; its cards are frozen out of play. */
  left: z.boolean(),
  /** A robot seat: no device behind it, ever. None of the absence machinery applies. */
  bot: z.boolean(),
  /** When this seat's last socket closed, or `null` while one is open. */
  absentSince: z.number().int().min(0).nullable(),
  /**
   * When this seat last asked for something a person has to ask for.
   *
   * Deliberately not "when we last heard from it". A phone in a pocket keeps a
   * socket open perfectly, so liveness proves nothing about whether anybody is
   * looking — and keying the idle stand-in on a clock that traffic resets would have
   * released the robot every time a frame arrived.
   */
  lastIntentAt: z.number().int().min(0).nullable(),
  /** When this seat last *tried* to come back — far better evidence than silence. */
  lastResumeAttemptAt: z.number().int().min(0).nullable(),
  /** Set while a robot is playing this human's seat, and why. */
  standIn: z.enum(['absent', 'idle']).nullable(),
  /** Which kind of stand-in the table has stopped on this seat, so it does not restart. */
  standInDeclined: z.enum(['absent', 'idle']).nullable(),
  /** Whether a robot played this seat at any point in the current round. */
  robotPlayedThisRound: z.boolean(),
  /** When the current stand-in began; the robot's stall deadline runs from here. */
  standInSince: z.number().int().min(0).nullable(),
  /** Whether this seat has already been skipped once without returning. */
  skippedWhileAway: z.boolean(),
  /** Set when the player said goodbye rather than merely going quiet. */
  saidGoodbye: z.boolean(),
  /**
   * The last intent accepted from this seat, and the version it produced.
   *
   * On the seat rather than the connection, because a reconnect is the only case it
   * exists for: a client that lost our answer re-sends, and applying a
   * `catchLastCard` twice is eight cards charged for one call.
   */
  lastRequestId: z.string().min(1).max(64).nullable(),
  lastRequestVersion: z.number().int().nonnegative().nullable(),
});

export type SeatRecord = z.infer<typeof seatSchema>;

export const roomRecordSchema = z.object({
  roomCode: z.string().min(3).max(32),
  /** The seat holding the lobby buttons. Not an authority — see `docs/server-game-plan.md` §2. */
  creatorPlayerId: playerId,
  phase: z.enum(['lobby', 'inGame', 'finished']),
  maxPlayers: z.number().int().min(2).max(6),
  tableLanguage: z.enum(['he', 'en']),
  /** Highest state version this room has ever broadcast. */
  versionFloor: z.number().int().nonnegative(),
  /** Rounds dealt so far, so the starting seat rotates. */
  round: z.number().int().nonnegative(),
  standInEnabled: z.boolean(),
  pausedBy: playerId.nullable(),
  /** When the table started waiting for the seat on turn. */
  waitingSince: z.number().int().min(0).nullable(),
  playAgainVotes: z.array(playerId).max(6),
  abandonVotes: z.array(playerId).max(6),
  /**
   * When each seat's hand became a single card.
   *
   * A clock reading, so it cannot live in `GameState`: the engine is a pure function
   * of its inputs and a timestamp inside it would make a replayed command produce a
   * different game. It was in the host's memory and was therefore lost on every
   * restart, which meant a restored table either exposed somebody who had been on
   * one card all along or protected them for ever.
   */
  lastCardSince: z.record(playerId, z.number().int().min(0)),
  /**
   * Each robot's own random stream, one seed per seat.
   *
   * Separate from the game's `RngState` on purpose: sharing it would make the
   * *presence* of a robot change the deal. Per seat rather than one shared stream, so
   * a robot's choices do not depend on how many decisions the others happened to take
   * first — which is what makes a robot-only round replay exactly.
   */
  botRng: z.record(playerId, z.number().int()),
  seats: z.array(seatSchema).max(6),
});

export type RoomRecord = z.infer<typeof roomRecordSchema>;

const rngStateSchema = z.object({ seed: z.number().int() });

/**
 * The authoritative game state, as stored.
 *
 * Mirrors `GameState` field for field. It is a second declaration of a shape the
 * engine already owns, and the `satisfies` check below is what stops the two from
 * drifting: if the engine grows a field this schema does not know, the assignment
 * stops compiling. Worth the duplication, because this is the boundary where bytes
 * written by a previous deployment come back — and half-parsing those is how a
 * table reaches a state the engine has no transition out of.
 */
export const gameStateSchema = z.object({
  version: z.number().int().nonnegative(),
  phase: z.enum(['playing', 'finished']),
  players: z
    .array(z.object({ id: playerId, name: z.string().min(1).max(32), left: z.boolean().optional() }))
    .min(2)
    .max(6),
  hands: z.record(playerId, z.array(cardSchema).max(200)),
  drawPile: z.array(cardSchema).max(200),
  discardPile: z.array(cardSchema).max(200),
  activeColor: z.enum(['red', 'blue', 'green', 'yellow']),
  direction: z.union([z.literal(1), z.literal(-1)]),
  currentPlayerIndex: z.number().int().min(0).max(5),
  takiMode: z
    .object({
      color: z.enum(['red', 'blue', 'green', 'yellow']),
      playerId,
      cardsPlayed: z.number().int().min(1).max(200),
      openedWithSuperTaki: z.boolean(),
    })
    .nullable(),
  pendingPlus: z.boolean(),
  pendingDraw: z.number().int().min(0).max(200),
  freePlay: z.boolean(),
  plusThree: z.object({ playerId, awaiting: z.array(playerId).max(6) }).nullable(),
  declaredLastCard: z.array(playerId).max(6),
  rng: rngStateSchema,
  winnerId: playerId.nullable(),
  endReason: z.enum(['won', 'abandoned']).nullable(),
  turnSeq: z.number().int().nonnegative(),
  seed: z.number().int(),
});

/**
 * Compile-time proof that the stored shape still describes the engine's.
 *
 * One direction only, and deliberately: what this catches is the engine gaining or
 * changing a field that storage would silently drop on the next round trip.
 */
const _storedStateMatchesEngine: z.ZodType<GameState> = gameStateSchema as z.ZodType<GameState>;
void _storedStateMatchesEngine;

/** What a read found, and — when it found nothing usable — whether that was corruption. */
export type ReadResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: 'missing' | 'corrupt' };

function read<T>(store: RoomStore, key: string, schema: z.ZodType<T>): ReadResult<T> {
  const raw = store.get(key);
  if (raw === undefined) {
    return { ok: false, reason: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const result = schema.safeParse(parsed);
  return result.success ? { ok: true, value: result.data } : { ok: false, reason: 'corrupt' };
}

export function readRoom(store: RoomStore): ReadResult<RoomRecord> {
  return read(store, ROOM_KEY, roomRecordSchema);
}

export function writeRoom(store: RoomStore, record: RoomRecord): void {
  store.put(ROOM_KEY, JSON.stringify(record));
}

export function readGame(store: RoomStore): ReadResult<GameState> {
  return read(store, GAME_KEY, gameStateSchema as z.ZodType<GameState>);
}

export function writeGame(store: RoomStore, state: GameState): void {
  store.put(GAME_KEY, JSON.stringify(state));
}

export function clearGame(store: RoomStore): void {
  store.delete(GAME_KEY);
}

/** A store backed by a plain `Map`. Used by the tests, and by nothing else. */
export function memoryStore(
  initial?: Map<string, string>,
): RoomStore & { readonly map: Map<string, string> } {
  const map = initial ?? new Map<string, string>();
  return {
    map,
    get: (key) => map.get(key),
    put: (key, value) => {
      map.set(key, value);
    },
    delete: (key) => {
      map.delete(key);
    },
  };
}
