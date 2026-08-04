import { z } from 'zod';
import { record } from '../../../lib/diagnostics.ts';
import { STORAGE_KEYS, readSessionJson, removeSessionRaw, writeSessionJson } from '../../../lib/storage.ts';
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
 * Kept in `sessionStorage`, deliberately. It contains every player's hand and the
 * order of the draw pile, so it must not outlive the tab that needs it; and a
 * reload — which `sessionStorage` survives — is the case worth recovering from.
 * A crash that also closes the tab is not recoverable this way, and that is an
 * accepted limit rather than an oversight: the alternative is writing everybody's
 * cards to persistent storage on a device that may be shared.
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
  lastRequestId: z.string().min(1).max(64).nullable().optional(),
  lastRequestVersion: z.number().int().nonnegative().nullable().optional(),
});

const snapshotSchema = z.object({
  roomCode: z.string().min(3).max(32),
  hostPeerId: z.string().min(1).max(64),
  generation: z.number().int().min(0).max(16),
  savedAt: z.number().int().min(0),
  hostPlayerId: z.string().min(1).max(64),
  phase: z.enum(['lobby', 'inGame', 'finished']),
  maxPlayers: z.number().int().min(2).max(6),
  tableLanguage: z.enum(['he', 'en']),
  versionFloor: z.number().int().nonnegative(),
  round: z.number().int().nonnegative(),
  seats: z.array(seatSchema).min(1).max(6).readonly(),
  game: gameStateSchema.nullable(),
});

export interface HostedRoom {
  readonly roomCode: string;
  readonly hostPeerId: string;
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
    game: data.game,
  };
}

export function loadHostedRoom(now: number = Date.now()): HostedRoom | null {
  return readSessionJson(STORAGE_KEYS.hostedRoom, (value) => validate(value, now));
}

export function clearHostedRoom(): void {
  removeSessionRaw(STORAGE_KEYS.hostedRoom);
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
    args.restore.seats.length,
    args.restore.seats.map((seat) => `${seat.playerId}:${seat.left === true ? '1' : '0'}`).join(','),
  ].join('|');
}

interface WriteArgs {
  readonly roomCode: string;
  readonly hostPeerId: string;
  readonly generation: number;
  readonly restore: HostRestoreState;
}

function write(args: WriteArgs, now: number): void {
  lastFullWriteAt = now;
  writeSessionJson(STORAGE_KEYS.hostedRoom, {
    roomCode: args.roomCode,
    hostPeerId: args.hostPeerId,
    generation: args.generation,
    savedAt: now,
    hostPlayerId: args.restore.hostPlayerId,
    phase: args.restore.phase,
    maxPlayers: args.restore.maxPlayers,
    tableLanguage: args.restore.tableLanguage,
    versionFloor: args.restore.versionFloor,
    round: args.restore.round,
    seats: args.restore.seats,
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

/** Test seam: forgets the throttle. */
export function __resetHostSnapshotThrottleForTests(): void {
  lastFullWriteAt = 0;
  lastShape = '';
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
}
