import { z } from 'zod';
import { record } from '../../../lib/diagnostics.ts';
import { STORAGE_KEYS, readJson, removeRaw, writeJson } from '../../../lib/storage.ts';
import { cardSchema } from '../network/protocol.ts';
import { isValidPeerId, isValidRoomCode } from '../network/roomCode.ts';
import type { HostRestoreState } from '../network/hostSession.ts';

/**
 * The host's own way back.
 *
 * Before this, a host that reloaded destroyed the game outright: the whole
 * `GameState` lived in one tab's memory and nothing was written down. It is the
 * single most common way a table lost an evening, and by some distance the most
 * annoying, because nothing had gone wrong with anybody's network.
 *
 * Kept in `localStorage`, with a TTL. It used to live in `sessionStorage`,
 * which made a host's reload recoverable but a closed tab or a crashed browser
 * fatal to the whole table — and "the game must survive anybody dropping,
 * including the host" is a requirement now. The snapshot contains every
 * player's hand and the order of the draw pile, so the price of persistence is
 * paid deliberately: the entry expires after `HOST_SNAPSHOT_TTL_MS`, is
 * validated (and removed) on every read, and is cleared the moment the host
 * leaves the room on purpose. See docs/threat-model.md.
 *
 * The relay holds the other half of the promise: the room's peer-id claim in
 * the snapshot is what the returning host presents to take its room code back,
 * however long it was away.
 *
 * Writes are split by cost. The small fields go down on every change; the full
 * game is throttled, because it is 8–12 KB of synchronous JSON and doing that on
 * the tap that plays a card is felt on a mid-range phone.
 */

export const HOST_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

const enginePlayerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  left: z.boolean().optional(),
});

const rngSchema = z.object({ seed: z.number().int() });

const gameStateSchema = z.object({
  version: z.number().int().nonnegative(),
  phase: z.enum(['playing', 'finished']),
  players: z.array(enginePlayerSchema).min(2).max(6).readonly(),
  hands: z.record(z.string(), z.array(cardSchema).readonly()),
  drawPile: z.array(cardSchema).readonly(),
  discardPile: z.array(cardSchema).readonly(),
  activeColor: z.enum(['red', 'blue', 'green', 'yellow']),
  direction: z.union([z.literal(1), z.literal(-1)]),
  currentPlayerIndex: z.number().int().min(0).max(5),
  takiMode: z
    .object({
      color: z.enum(['red', 'blue', 'green', 'yellow']),
      playerId: z.string().min(1).max(64),
      cardsPlayed: z.number().int().min(1).max(200),
      openedWithSuperTaki: z.boolean(),
    })
    .nullable(),
  pendingPlus: z.boolean(),
  pendingDraw: z.number().int().min(0).max(200),
  freePlay: z.boolean(),
  plusThree: z
    .object({
      playerId: z.string().min(1).max(64),
      awaiting: z.array(z.string().min(1).max(64)).max(6).readonly(),
    })
    .nullable(),
  declaredLastCard: z.array(z.string().min(1).max(64)).max(6).readonly(),
  rng: rngSchema,
  winnerId: z.string().min(1).max(64).nullable(),
  endReason: z.enum(['won', 'abandoned']).nullable(),
  turnSeq: z.number().int().nonnegative(),
  seed: z.number().int(),
});

const seatSchema = z.object({
  playerId: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  seat: z.number().int().min(0).max(5),
  isHost: z.boolean(),
  resumeToken: z.string().min(8).max(64),
  left: z.boolean().optional(),
  /**
   * A robot seat.
   *
   * It has to travel with the room, or a reload — or a handover — turns every robot
   * into a human seat with no device behind it: skipped every orbit, impossible to
   * resume, and holding a hand nobody can play.
   */
  bot: z.boolean().optional(),
  lastRequestId: z.string().min(1).max(64).nullable().optional(),
  lastRequestVersion: z.number().int().nonnegative().nullable().optional(),
});

const snapshotSchema = z.object({
  roomCode: z.string().min(3).max(32),
  hostPeerId: z.string().min(1).max(64),
  /** Relay claim for `hostPeerId`; what makes the room code reclaimable. */
  claim: z
    .string()
    .regex(/^[a-f0-9]{16,64}$/)
    .optional(),
  generation: z.number().int().min(0).max(16),
  savedAt: z.number().int().min(0),
  hostPlayerId: z.string().min(1).max(64),
  phase: z.enum(['lobby', 'inGame', 'finished']),
  maxPlayers: z.number().int().min(2).max(6),
  tableLanguage: z.enum(['he', 'en']),
  versionFloor: z.number().int().nonnegative(),
  round: z.number().int().nonnegative(),
  seats: z.array(seatSchema).min(1).max(6).readonly(),
  /** Whether the table lets a robot play a seat nobody is answering for. */
  standInEnabled: z.boolean().optional(),
  game: gameStateSchema.nullable(),
});

export interface HostedRoom {
  readonly roomCode: string;
  readonly hostPeerId: string;
  readonly claim: string | null;
  readonly generation: number;
  readonly savedAt: number;
  readonly restore: HostRestoreState;
}

function validate(value: unknown, now: number): HostedRoom | null {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  if (!isValidRoomCode(data.roomCode) || !isValidPeerId(data.hostPeerId)) {
    return null;
  }
  if (now - data.savedAt > HOST_SNAPSHOT_TTL_MS || data.savedAt > now + 60_000) {
    return null;
  }
  return {
    roomCode: data.roomCode,
    hostPeerId: data.hostPeerId,
    claim: data.claim ?? null,
    generation: data.generation,
    savedAt: data.savedAt,
    restore: {
      hostPlayerId: data.hostPlayerId,
      phase: data.phase,
      maxPlayers: data.maxPlayers,
      tableLanguage: data.tableLanguage,
      versionFloor: data.versionFloor,
      round: data.round,
      seats: data.seats,
      ...(data.standInEnabled !== undefined ? { standInEnabled: data.standInEnabled } : {}),
      game: data.game,
    },
  };
}

/**
 * Validates a room offered by another device during a handover.
 *
 * The same schema as a snapshot of our own, minus the fields that describe *where*
 * it was stored. It is checked rather than trusted not because the old host is
 * suspected — it is alive and cooperating on a channel this seat already trusts —
 * but because an unreadable state must fail here, before we start serving on it,
 * rather than half-way through the first move.
 */
export function validateHandoffSnapshot(value: unknown): HostRestoreState | null {
  const parsed = snapshotSchema
    .omit({ roomCode: true, hostPeerId: true, generation: true, savedAt: true })
    .safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  return {
    hostPlayerId: data.hostPlayerId,
    phase: data.phase,
    maxPlayers: data.maxPlayers,
    tableLanguage: data.tableLanguage,
    versionFloor: data.versionFloor,
    round: data.round,
    seats: data.seats,
    ...(data.standInEnabled !== undefined ? { standInEnabled: data.standInEnabled } : {}),
    game: data.game,
  };
}

export function loadHostedRoom(now: number = Date.now()): HostedRoom | null {
  return readJson(STORAGE_KEYS.hostedRoom, (value) => validate(value, now));
}

/**
 * How often the full game may be written.
 *
 * The small fields are cheap and go every time; the deck and the hands do not
 * need to, because the worst case of a slightly stale snapshot is that a
 * returning host re-broadcasts a table one move behind — and every client drops a
 * version older than the one it holds, so the disagreement resolves itself.
 */
const FULL_WRITE_INTERVAL_MS = 2_000;

let lastFullWriteAt = 0;
let pending: ReturnType<typeof setTimeout> | null = null;
let lastShape = '';

/**
 * A cheap fingerprint of everything except the cards.
 *
 * Throttling the whole snapshot was wrong: it delayed the phase and the seat list
 * as well as the deck, so a reload landing inside the throttle window would
 * restore a room that still believed it was in the lobby. Structural changes are
 * rare and small, so they are written at once; only the deck and the hands — which
 * change on every single move and cost 8-12 KB of synchronous JSON — wait.
 */
function shapeOf(args: WriteArgs): string {
  return [
    args.restore.phase,
    args.restore.versionFloor,
    args.restore.round,
    args.restore.maxPlayers,
    // A table setting, exactly like `maxPlayers`: a toggle that waited for the deck's
    // throttle could be dropped altogether by a write already in flight.
    args.restore.standInEnabled === false ? 'stand-in:off' : 'stand-in:on',
    args.restore.seats.length,
    // Bot-ness is structural: seating a robot must be written through at once, not
    // wait for the throttle that exists for the deck.
    args.restore.seats
      .map((seat) => `${seat.playerId}:${seat.left === true ? '1' : '0'}:${seat.bot === true ? 'b' : '-'}`)
      .join(','),
  ].join('|');
}

interface WriteArgs {
  readonly roomCode: string;
  readonly hostPeerId: string;
  readonly claim: string | null;
  readonly generation: number;
  readonly restore: HostRestoreState;
}

function write(args: WriteArgs, now: number): void {
  lastFullWriteAt = now;
  writeJson(STORAGE_KEYS.hostedRoom, {
    roomCode: args.roomCode,
    hostPeerId: args.hostPeerId,
    ...(args.claim === null ? {} : { claim: args.claim }),
    generation: args.generation,
    savedAt: now,
    hostPlayerId: args.restore.hostPlayerId,
    phase: args.restore.phase,
    maxPlayers: args.restore.maxPlayers,
    tableLanguage: args.restore.tableLanguage,
    versionFloor: args.restore.versionFloor,
    round: args.restore.round,
    seats: args.restore.seats,
    standInEnabled: args.restore.standInEnabled,
    game: args.restore.game,
  });
}

/** Records the room, throttling the expensive part. */
export function saveHostedRoom(args: WriteArgs, now: number = Date.now()): void {
  const shape = shapeOf(args);
  const structural = shape !== lastShape;
  lastShape = shape;
  if (structural || now - lastFullWriteAt >= FULL_WRITE_INTERVAL_MS) {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
    write(args, now);
    return;
  }
  if (pending !== null) {
    return;
  }
  pending = setTimeout(
    () => {
      pending = null;
      write(args, Date.now());
    },
    FULL_WRITE_INTERVAL_MS - (now - lastFullWriteAt),
  );
}

/** Writes immediately, whatever the throttle says. Used when the page is going away. */
export function flushHostedRoom(args: WriteArgs, now: number = Date.now()): void {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  write(args, now);
  record('hostSnapshot', 'flushed', { phase: args.restore.phase });
}

export function clearHostedRoom(): void {
  /*
   * Cancel the throttled write first. A deferred write that fires after the room
   * has been forgotten would put it straight back, so a player who left the room
   * would be offered it again the next time they saw the home screen.
   */
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  lastShape = '';
  removeRaw(STORAGE_KEYS.hostedRoom);
}

/** Test seam: forgets the throttle. */
export function __resetHostSnapshotThrottleForTests(): void {
  lastFullWriteAt = 0;
  lastShape = '';
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
}
