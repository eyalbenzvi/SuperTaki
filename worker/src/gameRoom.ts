/**
 * The room, and the whole of the game's authority.
 *
 * This is what `src/features/game/network/hostSession.ts` used to be, moved off a
 * player's phone and into the Durable Object that every player is already connected
 * to. It holds the only complete `GameState`, validates every move through the pure
 * engine, deals every hand, drives the robots and owns every deadline. Every
 * player — including whoever opened the room — is an ordinary client of it.
 *
 * The platform is held at arm's length, exactly as the old `RoomCore` held it:
 * sockets, storage, the alarm queue and the clock are all injected, so the entire
 * room runs in plain Node with no workerd. `room.ts` is a thin adapter. That is
 * what makes the tests in `worker/test/` possible, and it is the reason this file
 * contains no `Date.now()`, no `setTimeout` and no reference to a `WebSocket`.
 *
 * What is deliberately *not* here, and used to be:
 *
 * - **Presence inference.** No ping nonces, no `ProbeTracker`, no counting of
 *   missed probes, no `'unstable'`. The runtime tells the room when a socket closes.
 *   An observation replaced roughly two hundred lines of guessing.
 * - **Any notion of the room moving.** No handover, no generations, no snapshot to
 *   ship to a successor, no "the host is restarting". The room is where it is.
 * - **A local player.** The old host was a player *and* the authority, so half its
 *   methods came in pairs — one for a remote seat, one for its own. There is one
 *   path now, and every seat takes it.
 */

import type { BotMove, BotMoveKind } from '../../src/features/game/bot/policy.ts';
import { robotName } from '../../src/features/game/bot/names.ts';
import { BotRunner } from '../../src/features/game/bot/runner.ts';
import { botViewFor } from '../../src/features/game/bot/view.ts';
import { applyCommand, createGame, currentPlayer } from '../../src/features/game/engine/engine.ts';
import { createRng, nextFloat, seedFromString } from '../../src/features/game/engine/prng.ts';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type EnginePlayer,
  type GameCommand,
  type GameEvent,
  type GameState,
  type RejectionCode,
} from '../../src/features/game/engine/state.ts';
import { toPrivateHandView, toPublicGameState } from '../../src/features/game/engine/views.ts';
import { MessageDeduplicator, roomMessage } from '../../src/features/game/network/envelope.ts';
import {
  parseClientMessage,
  type ClientMessage,
  type GameAction,
  type JoinRejectionReason,
  type LobbyPlayer,
  type LobbySnapshot,
  type RoomCommand,
  type RoomMessage,
} from '../../src/features/game/network/protocol.ts';
import {
  ABSENT_TURN_GRACE_CLOSED_MS,
  BOT_STALL_MS,
  IDLE_TURN_NUDGE_MS,
  LAST_CARD_GRACE_MS,
  LOBBY_GRACE_MS,
  RESUME_ATTEMPT_SUPPRESSES_SKIP_MS,
  SEAT_GRACE_MS,
  STAND_IN_ABSENT_MS,
  STAND_IN_IDLE_MS,
} from '../../src/features/game/network/timing.ts';
import { createPlayerId, createResumeToken } from '../../src/lib/id.ts';
import { sanitizeDisplayName, uniquifyDisplayName } from '../../src/lib/sanitize.ts';
import type { AlarmKind, AlarmMux } from './alarms.ts';
import {
  CLOSE_BAD_FRAME,
  CLOSE_REJECTED,
  CLOSE_SUPERSEDED,
  MAX_FRAME_BYTES,
  ROOM_IDLE_TTL_MS,
} from './protocol.ts';
import {
  clearGame,
  readGame,
  readRoom,
  writeGame,
  writeRoom,
  type RoomRecord,
  type RoomStore,
  type SeatRecord,
} from './storage.ts';

/** What the room needs from a WebSocket. */
export interface RoomSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** One live socket, and the seat it has proved it owns. */
interface Connection {
  readonly socket: RoomSocket;
  playerId: string | null;
  readonly dedup: MessageDeduplicator;
}

export interface GameRoomOptions {
  readonly roomCode: string;
  readonly store: RoomStore;
  readonly alarms: AlarmMux;
  /** Sockets that survived a hibernation, with the seats they were bound to. */
  readonly restore?: readonly { readonly socket: RoomSocket; readonly playerId: string }[];
  readonly now?: () => number;
  readonly seedFactory?: () => number;
  /**
   * Robot pacing override.
   *
   * A test that had to wait out a human-shaped thinking pause for every move of a
   * six-card Taki sequence would be minutes long. With this it is instant, and the
   * decisions are identical because they come from the seeded stream either way.
   */
  readonly botPauseMs?: (kind: BotMoveKind, inSequence: boolean) => number;
  /** Where a room reports things worth knowing. Wired to `console` by the adapter. */
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * Turns a requested action into an engine command.
 *
 * The player id comes from the connection, never from the message: that is the
 * whole of the authorisation model. Every field an action carries beyond its type
 * is copied out explicitly, so a new action cannot reach the engine by accident —
 * and `skipTurn`, `leaveGame` and `abandonRound` are unreachable from here by
 * construction, which is what keeps them the room's own.
 */
function buildCommand(playerId: string, action: GameAction): GameCommand {
  switch (action.type) {
    case 'playCard':
      return {
        type: 'playCard',
        playerId,
        cardId: action.cardId,
        ...(action.chosenColor ? { chosenColor: action.chosenColor } : {}),
      };
    case 'catchLastCard':
      return { type: 'catchLastCard', playerId, targetId: action.targetId };
    default:
      return { type: action.type, playerId };
  }
}

/**
 * Intents that belong to a turn, and may therefore be checked against one.
 *
 * Declaring last card, catching somebody who did not, and answering a +3 are
 * deliberately absent: they are legal at any moment, they race each other on
 * purpose, and gating them on a turn would hand every tie to whichever player broke
 * the rule.
 */
const TURN_SCOPED: ReadonlySet<GameAction['type']> = new Set<GameAction['type']>([
  'playCard',
  'drawCard',
  'closeTaki',
]);

/**
 * Nothing is ever booked closer than this to now.
 *
 * A backstop against a runaway alarm, which is the one failure mode here that costs
 * real money. The shape of it: an alarm fires, its handler cannot make progress —
 * the engine refuses the skip, say — and `reschedule` computes the same already-past
 * deadline again, so the platform fires it again immediately, for ever.
 *
 * The guards in `passAbsentTurn` mean the engine should never refuse, so this should
 * never be load-bearing. It exists because "should never" is a claim about today's
 * code, and the cost of being wrong without it is unbounded. With it, a stuck table
 * wakes once a second: still visible in the logs, still a bug, but 1,000 times
 * cheaper and comfortably inside the free plan's daily budget.
 *
 * One second is far below every deadline it clamps — the shortest is the twelve-second
 * absent-turn grace — so it is invisible to players.
 */
const ALARM_FLOOR_MS = 1_000;

function freshSeat(
  overrides: Partial<SeatRecord> & Pick<SeatRecord, 'playerId' | 'name' | 'seat'>,
): SeatRecord {
  return {
    resumeToken: createResumeToken(),
    left: false,
    bot: false,
    absentSince: null,
    lastIntentAt: null,
    lastResumeAttemptAt: null,
    standIn: null,
    standInDeclined: null,
    robotPlayedThisRound: false,
    standInSince: null,
    skippedWhileAway: false,
    saidGoodbye: false,
    lastRequestId: null,
    lastRequestVersion: null,
    ...overrides,
  };
}

export class GameRoom {
  private readonly connections = new Map<RoomSocket, Connection>();
  private readonly store: RoomStore;
  private readonly alarms: AlarmMux;
  private readonly now: () => number;
  private readonly seedFactory: () => number;
  private readonly log: (message: string, detail?: Record<string, unknown>) => void;
  private readonly bots: BotRunner;

  private record: RoomRecord | null;
  private game: GameState | null;
  /** Set by anything that changed durable state, cleared by `flush()`. */
  private roomDirty = false;
  private gameDirty = false;

  readonly roomCode: string;

  constructor(options: GameRoomOptions) {
    this.roomCode = options.roomCode;
    this.store = options.store;
    this.alarms = options.alarms;
    // Wrapped rather than captured: taking a reference to `Date.now` freezes
    // whichever implementation was installed when the room was built, which makes
    // the clock unswappable and is a trap for anything reasoning about time.
    this.now = options.now ?? ((): number => Date.now());
    this.seedFactory = options.seedFactory ?? ((): number => Math.floor(Math.random() * 0x7fffffff));
    this.log = options.log ?? ((): void => {});

    const room = readRoom(this.store);
    if (!room.ok && room.reason === 'corrupt') {
      /*
       * Storage written by a version of this worker that shaped it differently, or
       * damaged some other way. Treated as *no room* rather than partly believed: a
       * half-parsed table can sit in a state the engine has no transition out of,
       * and every seat's move is then refused with nothing to explain it. Players
       * are told the room is closed, which is true and actionable.
       */
      this.log('discarding an unreadable room record');
      this.store.delete('room');
      this.store.delete('game');
    }
    this.record = room.ok ? room.value : null;

    const stored = this.record === null ? null : readGame(this.store);
    if (stored !== null && !stored.ok && stored.reason === 'corrupt') {
      this.log('discarding an unreadable game state');
      clearGame(this.store);
      if (this.record !== null) {
        // A room whose round cannot be read is back in its lobby. The seats and
        // their credentials are intact, so the table can simply deal again.
        this.record = { ...this.record, phase: 'lobby' };
        this.roomDirty = true;
      }
    }
    this.game = stored?.ok === true ? stored.value : null;

    for (const entry of options.restore ?? []) {
      this.connections.set(entry.socket, {
        socket: entry.socket,
        playerId: entry.playerId,
        dedup: new MessageDeduplicator(),
      });
    }
    this.reconcilePresence();

    this.bots = new BotRunner({
      view: (playerId) => {
        const seat = this.seatFor(playerId);
        if (!this.game || this.record?.phase !== 'inGame' || !seat || seat.left) {
          return null;
        }
        // The same two projections a human client is sent, and nothing else.
        return botViewFor(this.game, playerId, (id) => this.seatCanAnswer(id));
      },
      controlled: () =>
        this.robotSeats().map((seat) => ({ playerId: seat.playerId, standIn: seat.standIn !== null })),
      blocked: () =>
        this.record === null ||
        this.record.pausedBy !== null ||
        this.record.phase !== 'inGame' ||
        this.game === null,
      submit: (playerId, move) => this.submitBotMove(playerId, move),
      random: (playerId) => this.botRandom(playerId),
      /*
       * A robot's pause is an alarm, not a timer, so the callback is discarded: an
       * alarm wakes an object that may have been evicted from memory in the
       * meantime, and there would be no closure left to call. What the alarm does
       * instead is `bots.pump()`, which is exactly what this callback would have
       * done — forget the pause, look at the table again, act.
       *
       * One consequence worth stating: a pause interrupted by a hibernation is
       * re-decided on the way back, which draws from that seat's random stream
       * again. A round is therefore bit-exactly reproducible only if the room stayed
       * in memory throughout. The host this replaces had the same property across a
       * reload, and it costs nothing anybody can see.
       */
      /*
       * Not clamped by {@link ALARM_FLOOR_MS}, unlike everything `reschedule` books.
       * A zero pause is meaningful here — it is how a robot covering somebody else's
       * seat declares their last card with no window in which they can be caught for
       * a rule they were not there to keep — and a floor would quietly hand that
       * penalty back. It cannot spin, either: a move the table refuses goes into the
       * runner's `refused` set and is not asked for again at that version.
       */
      schedule: (_run, ms) => {
        this.alarms.set('botMove', this.now() + Math.max(ms, 0));
        return () => {
          this.alarms.clear('botMove');
        };
      },
      ...(options.botPauseMs ? { pauseMs: options.botPauseMs } : {}),
    });
  }

  // --------------------------------------------------------------- lifecycle

  /** Whether this room has ever been created. Used by the adapter's TTL sweep. */
  get exists(): boolean {
    return this.record !== null;
  }

  /** Live seats, for the adapter's emptiness check. */
  get liveConnectionCount(): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (connection.playerId !== null) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Writes anything that changed and settles the alarm queue.
   *
   * Called once at the end of every entry point rather than after each mutation, so
   * one message is one write however many things it touched.
   */
  flush(): void {
    if (this.roomDirty && this.record !== null) {
      writeRoom(this.store, this.record);
    }
    if (this.gameDirty) {
      if (this.game === null) {
        clearGame(this.store);
      } else {
        writeGame(this.store, this.game);
      }
    }
    this.roomDirty = false;
    this.gameDirty = false;
    this.reschedule();
  }

  // ---------------------------------------------------------------- messaging

  private get messageContext(): { roomId: string; senderPeerId: string; now: () => number } {
    return { roomId: this.roomCode, senderPeerId: 'room', now: this.now };
  }

  private send<TType extends RoomMessage['type']>(
    socket: RoomSocket,
    type: TType,
    payload: Extract<RoomMessage, { type: TType }>['payload'],
  ): void {
    // `payload` is precisely typed by this signature; the inner generic cannot
    // re-derive it from a forwarded type parameter.
    socket.send(JSON.stringify(roomMessage(this.messageContext, type, payload as never)));
  }

  private broadcast<TType extends RoomMessage['type']>(
    type: TType,
    payload: Extract<RoomMessage, { type: TType }>['payload'],
  ): void {
    for (const connection of this.connections.values()) {
      if (connection.playerId !== null) {
        this.send(connection.socket, type, payload as never);
      }
    }
  }

  private connectionForPlayer(playerId: string): Connection | null {
    for (const connection of this.connections.values()) {
      if (connection.playerId === playerId) {
        return connection;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------- seats

  private seatFor(playerId: string): SeatRecord | undefined {
    return this.record?.seats.find((seat) => seat.playerId === playerId);
  }

  /** Whether somebody is answering for this seat: an open socket, or a robot's nature. */
  private present(seat: SeatRecord): boolean {
    return seat.bot || this.connectionForPlayer(seat.playerId) !== null;
  }

  /** Whether a robot is playing this seat, for any reason. */
  private robotControls(seat: SeatRecord): boolean {
    return (seat.bot || seat.standIn !== null) && !seat.left;
  }

  /** Seats a robot is playing, in seat order. */
  private robotSeats(): SeatRecord[] {
    return (this.record?.seats ?? [])
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .filter((seat) => this.robotControls(seat));
  }

  /**
   * Whether this seat could answer for itself.
   *
   * The one thing it decides is whether the seat can be called out for sitting on a
   * silent last card: somebody who is not there cannot shout. A seat a robot is
   * playing counts, because the robot can.
   */
  private seatCanAnswer(playerId: string): boolean {
    const seat = this.seatFor(playerId);
    return seat !== undefined && (this.present(seat) || this.robotControls(seat));
  }

  /**
   * The seat that holds the lobby buttons.
   *
   * `creatorPlayerId` normally names it. When that seat has left the room entirely —
   * swept out of a lobby, or removed — the powers pass to the lowest-numbered seat
   * that is left, because the alternative is a table that can never be started. The
   * old design could not reach this state: the host was the authority, so a room
   * without one was not a room.
   */
  private creatorSeat(): SeatRecord | undefined {
    const record = this.record;
    if (record === undefined || record === null) {
      return undefined;
    }
    const named = this.seatFor(record.creatorPlayerId);
    if (named !== undefined) {
      return named;
    }
    return record.seats.slice().sort((a, b) => a.seat - b.seat)[0];
  }

  private resequenceSeats(): void {
    (this.record?.seats ?? [])
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .forEach((seat, index) => {
        seat.seat = index;
      });
  }

  /**
   * Brings persisted absence in line with the sockets we actually hold.
   *
   * Runs once per wake. Both directions matter: a seat whose socket survived should
   * not still be counted absent, and a seat whose socket died while the object was
   * evicted has to start its clock now rather than never — the close event that
   * would normally start it may have been the very thing that woke us, or may have
   * been lost with the object.
   */
  private reconcilePresence(): void {
    const record = this.record;
    if (record === null) {
      return;
    }
    const now = this.now();
    for (const seat of record.seats) {
      if (seat.bot) {
        continue;
      }
      const live = this.connectionForPlayer(seat.playerId) !== null;
      if (live && seat.absentSince !== null) {
        seat.absentSince = null;
        this.roomDirty = true;
      } else if (!live && seat.absentSince === null) {
        seat.absentSince = now;
        this.roomDirty = true;
      }
    }
  }

  // -------------------------------------------------------------------- lobby

  /** Who the table is waiting for, and why — so no screen has to work it out. */
  private waiting(): { playerId: string | null; reason: LobbySnapshot['waitingReason'] } {
    const record = this.record;
    if (record === null) {
      return { playerId: null, reason: null };
    }
    if (record.pausedBy !== null) {
      return { playerId: record.pausedBy, reason: 'paused' };
    }
    if (!this.game || record.phase !== 'inGame') {
      return { playerId: null, reason: null };
    }
    if (this.game.plusThree !== null) {
      return { playerId: this.game.plusThree.playerId, reason: 'breaker' };
    }
    const onTurn = currentPlayer(this.game);
    if (!onTurn) {
      return { playerId: null, reason: null };
    }
    const seat = this.seatFor(onTurn.id);
    return {
      playerId: onTurn.id,
      /*
       * A seat a robot is playing is never reported as absent, however gone its
       * owner is. Nothing is being waited for: the table is moving, and telling every
       * screen it is holding a seat would contradict what they can see.
       */
      reason: seat && !this.present(seat) && !this.robotControls(seat) ? 'absent' : 'turn',
    };
  }

  private lobbySnapshot(): LobbySnapshot {
    const record = this.record;
    if (record === null) {
      throw new Error('no room to describe');
    }
    const creatorId = this.creatorSeat()?.playerId ?? record.creatorPlayerId;
    const players: LobbyPlayer[] = record.seats
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((seat) => ({
        id: seat.playerId,
        name: seat.name,
        isCreator: seat.playerId === creatorId,
        health: this.present(seat) ? ('connected' as const) : ('disconnected' as const),
        seat: seat.seat,
        ...(seat.absentSince !== null && !this.present(seat) ? { absentSince: seat.absentSince } : {}),
        ...(seat.left ? { left: true } : {}),
        ...(seat.bot ? { bot: true } : {}),
        ...(seat.standIn !== null ? { standIn: true } : {}),
        ...(seat.robotPlayedThisRound && !seat.bot ? { robotPlayed: true } : {}),
      }));
    const waiting = this.waiting();
    return {
      roomCode: this.roomCode,
      creatorPlayerId: creatorId,
      maxPlayers: record.maxPlayers,
      phase: record.phase,
      players,
      tableLanguage: record.tableLanguage,
      sentAt: this.now(),
      seatGraceMs: SEAT_GRACE_MS,
      pausedBy: record.pausedBy,
      waitingFor: waiting.playerId,
      waitingReason: waiting.reason,
      waitingSince: record.waitingSince,
      abandonVotes: [...record.abandonVotes],
      standInEnabled: record.standInEnabled,
    };
  }

  private emitLobby(): void {
    if (this.record !== null) {
      this.broadcast('lobbyState', { lobby: this.lobbySnapshot() });
    }
  }

  // --------------------------------------------------------------- connections

  /** A socket that survived a hibernation, re-bound from its saved seat. */
  restore(socket: RoomSocket, playerId: string): void {
    this.connections.set(socket, { socket, playerId, dedup: new MessageDeduplicator() });
  }

  /** The seat a socket has proved it owns, once its join has been accepted. */
  identityOf(socket: RoomSocket): string | null {
    return this.connections.get(socket)?.playerId ?? null;
  }

  private connectionFor(socket: RoomSocket): Connection {
    let connection = this.connections.get(socket);
    if (connection === undefined) {
      connection = { socket, playerId: null, dedup: new MessageDeduplicator() };
      this.connections.set(socket, connection);
    }
    return connection;
  }

  /** A socket died, or the client closed it. */
  handleClose(socket: RoomSocket): void {
    const connection = this.connections.get(socket);
    this.connections.delete(socket);
    if (connection?.playerId == null) {
      this.flush();
      return;
    }
    const seat = this.seatFor(connection.playerId);
    if (seat === undefined) {
      this.flush();
      return;
    }
    if (!this.present(seat) && seat.absentSince === null) {
      seat.absentSince = this.now();
      this.roomDirty = true;
    }
    this.log('a seat went quiet', { seat: seat.seat, name: seat.name });
    this.emitLobby();
    this.bots.schedule();
    this.flush();
  }

  private reject(socket: RoomSocket, reason: JoinRejectionReason): void {
    this.send(socket, 'joinRejected', { reason });
    socket.close(CLOSE_REJECTED, reason);
    this.connections.delete(socket);
  }

  // ----------------------------------------------------------------- messages

  /** Handles one inbound text frame. */
  handleMessage(socket: RoomSocket, raw: string): void {
    if (raw.length > MAX_FRAME_BYTES) {
      // Dropped without being parsed: this is a memory bound, and honouring it means
      // not allocating the thing it is bounding.
      socket.close(CLOSE_BAD_FRAME, 'frame too large');
      this.connections.delete(socket);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      socket.close(CLOSE_BAD_FRAME, 'malformed frame');
      this.connections.delete(socket);
      return;
    }
    const parsed = parseClientMessage(value);
    if (!parsed.ok) {
      if (parsed.error === 'protocolMismatch') {
        /*
         * A tab holding a cached older bundle. It is told so rather than dropped
         * silently, because a silent drop reads as a network fault and the player
         * would sit watching a spinner instead of reloading.
         */
        this.reject(socket, 'protocolMismatch');
        return;
      }
      this.log('rejected a message', { error: parsed.error });
      return;
    }
    const message = parsed.message;
    if (message.roomId !== this.roomCode) {
      return;
    }
    const connection = this.connectionFor(socket);
    if (!connection.dedup.accept(message.id)) {
      return;
    }
    this.dispatch(connection, message);
    this.flush();
  }

  private dispatch(connection: Connection, message: ClientMessage): void {
    switch (message.type) {
      case 'joinRequest':
        this.handleJoin(connection, message.payload);
        return;
      case 'resumeRequest':
        this.handleResume(connection, message.payload.playerId, message.payload.resumeToken);
        return;
      case 'action':
        this.stampIntent(connection.playerId);
        this.handleAction(connection, message.payload);
        return;
      case 'playAgainVote':
        this.stampIntent(connection.playerId);
        this.handlePlayAgainVote(connection, message.payload.agree);
        return;
      case 'pauseRequest':
        this.stampIntent(connection.playerId);
        if (connection.playerId !== null) {
          this.setPaused(message.payload.paused ? connection.playerId : null);
        }
        return;
      case 'abandonVote':
        this.stampIntent(connection.playerId);
        if (connection.playerId !== null) {
          this.setAbandonVote(connection.playerId, message.payload.agree);
        }
        return;
      case 'nudge':
        this.stampIntent(connection.playerId);
        this.handleNudge(connection, message.payload.targetPlayerId);
        return;
      case 'roomCommand':
        this.stampIntent(connection.playerId);
        this.handleRoomCommand(connection, message.payload.command);
        return;
      case 'leave':
        this.handleLeave(connection);
        return;
    }
  }

  /**
   * Records that somebody actually asked for something.
   *
   * Distinct from a socket merely being open, and that distinction is the whole of
   * the idle stand-in: an open socket says a device is powered on, an intent says a
   * person is holding it. A robot that stepped in for a silent seat stands down here,
   * at once — before whatever the player asked for is even applied, so their own move
   * is the first thing that happens when they come back.
   */
  private stampIntent(playerId: string | null): void {
    if (playerId === null) {
      return;
    }
    const seat = this.seatFor(playerId);
    if (seat === undefined) {
      return;
    }
    seat.lastIntentAt = this.now();
    // A refusal belongs to the silence it was made about, and this ends that silence.
    seat.standInDeclined = null;
    this.roomDirty = true;
    if (seat.standIn !== null) {
      this.endStandIn(seat);
      this.emitLobby();
      this.bots.schedule();
    }
  }

  // -------------------------------------------------------------------- joining

  private handleJoin(
    connection: Connection,
    payload: {
      readonly displayName: string;
      readonly create?: { maxPlayers: number; tableLanguage: 'he' | 'en' };
    },
  ): void {
    if (connection.playerId !== null) {
      /*
       * Answer again rather than staying silent. A lost `joinAccepted` used to be
       * unrecoverable: the client retried, this returned early, and the join timed
       * out — with no credential stored either, because the credential arrives in the
       * message that went missing.
       */
      const seat = this.seatFor(connection.playerId);
      if (seat !== undefined) {
        this.sendJoinAccepted(connection, seat);
      }
      return;
    }

    const cleaned = sanitizeDisplayName(payload.displayName);
    if (cleaned.length === 0) {
      this.reject(connection.socket, 'invalidName');
      return;
    }

    if (payload.create !== undefined) {
      if (this.record !== null && this.record.seats.length > 0) {
        // A room code collision. The client draws another six digits, exactly as it
        // did when the relay refused a peer-id claim.
        this.reject(connection.socket, 'roomTaken');
        return;
      }
      this.createRoom(connection, cleaned, payload.create);
      return;
    }

    const record = this.record;
    if (record === null) {
      // Either a mistyped code or a room that has been forgotten. Both are honestly
      // described as closed, and both are answered the same way: there is nothing here.
      this.reject(connection.socket, 'roomClosed');
      return;
    }
    if (record.phase !== 'lobby') {
      this.reject(connection.socket, 'gameInProgress');
      return;
    }
    if (record.seats.length >= record.maxPlayers) {
      this.reject(connection.socket, 'roomFull');
      return;
    }

    const seat = freshSeat({
      playerId: createPlayerId(),
      name: uniquifyDisplayName(
        cleaned,
        record.seats.map((existing) => existing.name),
      ),
      seat: record.seats.length,
      lastIntentAt: this.now(),
    });
    record.seats.push(seat);
    connection.playerId = seat.playerId;
    this.roomDirty = true;
    this.log('seated a player', { name: seat.name, seat: seat.seat });

    this.sendJoinAccepted(connection, seat);
    this.emitLobby();
  }

  private createRoom(
    connection: Connection,
    name: string,
    options: { maxPlayers: number; tableLanguage: 'he' | 'en' },
  ): void {
    const seat = freshSeat({
      playerId: createPlayerId(),
      name,
      seat: 0,
      lastIntentAt: this.now(),
    });
    this.record = {
      roomCode: this.roomCode,
      creatorPlayerId: seat.playerId,
      phase: 'lobby',
      maxPlayers: Math.min(Math.max(options.maxPlayers, MIN_PLAYERS), MAX_PLAYERS),
      tableLanguage: options.tableLanguage,
      versionFloor: 0,
      round: 0,
      standInEnabled: true,
      pausedBy: null,
      waitingSince: null,
      playAgainVotes: [],
      abandonVotes: [],
      lastCardSince: {},
      botRng: {},
      seats: [seat],
    };
    this.game = null;
    connection.playerId = seat.playerId;
    this.roomDirty = true;
    this.log('room created', { by: seat.name });
    this.sendJoinAccepted(connection, seat);
  }

  private sendJoinAccepted(connection: Connection, seat: SeatRecord): void {
    this.send(connection.socket, 'joinAccepted', {
      playerId: seat.playerId,
      resumeToken: seat.resumeToken,
      displayName: seat.name,
      lobby: this.lobbySnapshot(),
    });
  }

  /**
   * Somebody is coming back to a seat they already hold.
   *
   * Every seat is resumable, including the room creator's. That is the change this
   * whole piece of work exists for: the old host refused its own seat here, because
   * its seat was the authority and the authority could not rejoin itself.
   */
  private handleResume(connection: Connection, playerId: string, resumeToken: string): void {
    const record = this.record;
    if (record === null) {
      this.reject(connection.socket, 'roomClosed');
      return;
    }
    const seat = this.seatFor(playerId);
    // A robot's seat is not a seat anybody can come back to.
    if (seat === undefined || seat.bot) {
      this.reject(connection.socket, 'unknownSeat');
      return;
    }
    if (seat.left) {
      /*
       * The seat was retired from this round. Seating them anyway would put a player
       * at a table where every move is refused as coming from somebody who has left —
       * a dead end with no explanation. `unknownSeat` makes the client drop the
       * credential, so what they are offered is a fresh join.
       */
      this.reject(connection.socket, 'unknownSeat');
      return;
    }
    // Constant-time comparison is unnecessary: the token is a reconnection secret for
    // a game with no stakes, not an authentication credential guarding anything.
    if (seat.resumeToken !== resumeToken) {
      this.reject(connection.socket, 'invalidResumeToken');
      return;
    }

    // Recorded before anything else can fail: a rejoin *attempt* is what calls off a
    // pending skip, and it is worth knowing about even if this attempt dies.
    seat.lastResumeAttemptAt = this.now();

    const existing = this.connectionForPlayer(playerId);
    if (existing !== null && existing !== connection) {
      /*
       * The same seat on a fresh socket: a reload, or a network handover where the old
       * connection has not died yet. The new one wins — it is the one with a person
       * behind it.
       */
      existing.playerId = null;
      existing.socket.close(CLOSE_SUPERSEDED, 'superseded by a newer connection');
      this.connections.delete(existing.socket);
    }

    connection.playerId = seat.playerId;
    seat.absentSince = null;
    seat.skippedWhileAway = false;
    seat.saidGoodbye = false;
    seat.standInDeclined = null;
    // Coming back is the strongest intent there is, and it takes the seat back off
    // whichever robot was keeping it warm.
    seat.lastIntentAt = this.now();
    this.endStandIn(seat);
    this.roomDirty = true;
    this.log('a seat came back', { seat: seat.seat, name: seat.name });

    this.sendJoinAccepted(connection, seat);
    this.emitLobby();
    if (this.game !== null) {
      this.send(connection.socket, 'publicState', { state: toPublicGameState(this.game) });
      this.send(connection.socket, 'privateHand', { hand: toPrivateHandView(this.game, seat.playerId) });
    }
    this.bots.schedule();
  }

  private handleLeave(connection: Connection): void {
    const playerId = connection.playerId;
    connection.playerId = null;
    const record = this.record;
    if (playerId !== null && record !== null) {
      const index = record.seats.findIndex((seat) => seat.playerId === playerId);
      if (index >= 0 && record.phase === 'lobby') {
        record.seats.splice(index, 1);
        this.resequenceSeats();
        delete record.botRng[playerId];
      } else if (index >= 0) {
        const seat = record.seats[index] as SeatRecord;
        // Saying goodbye is an intent like any other, so a robot standing in for their
        // silence stops — and `saidGoodbye` keeps another one from starting, because
        // playing the hand of somebody who said they were done is not a favour.
        seat.lastIntentAt = this.now();
        this.endStandIn(seat);
        if (seat.absentSince === null) {
          seat.absentSince = this.now();
        }
        /*
         * A goodbye is a strong hint, not a removal. It shortens the wait before their
         * turn is passed, because there is nothing left to wait for — but taking the
         * seat out of the round here would burn their credential and, at a two-player
         * table, end the round the instant somebody mis-taps.
         */
        seat.saidGoodbye = true;
      }
      record.playAgainVotes = record.playAgainVotes.filter((id) => id !== playerId);
      record.abandonVotes = record.abandonVotes.filter((id) => id !== playerId);
      this.roomDirty = true;
    }
    connection.socket.close(1000, 'bye');
    this.connections.delete(connection.socket);
    this.emitLobby();
    this.bots.schedule();
  }

  // --------------------------------------------------------------------- game

  private trackLastCard(): void {
    const record = this.record;
    if (record === null) {
      return;
    }
    const game = this.game;
    if (game === null) {
      record.lastCardSince = {};
      this.roomDirty = true;
      return;
    }
    const now = this.now();
    for (const player of game.players) {
      if ((game.hands[player.id] ?? []).length === 1) {
        record.lastCardSince[player.id] ??= now;
      } else {
        delete record.lastCardSince[player.id];
      }
    }
    this.roomDirty = true;
  }

  /** Whether `playerId` is still inside the head start their last card bought them. */
  private withinLastCardGrace(playerId: string): boolean {
    const since = this.record?.lastCardSince[playerId];
    return since !== undefined && this.now() - since < LAST_CARD_GRACE_MS;
  }

  private broadcastGameState(): void {
    const game = this.game;
    if (game === null) {
      return;
    }
    const publicState = toPublicGameState(game);
    for (const connection of this.connections.values()) {
      if (connection.playerId === null) {
        continue;
      }
      this.send(connection.socket, 'publicState', { state: publicState });
      /*
       * The one place a hand crosses the wire, and it goes to exactly one socket —
       * the one bound to that seat. There is no path from here to a broadcast: the
       * projection is built per connection, from that connection's own player id.
       */
      this.send(connection.socket, 'privateHand', { hand: toPrivateHandView(game, connection.playerId) });
    }
  }

  private emitEvents(events: readonly GameEvent[]): void {
    if (events.length === 0) {
      return;
    }
    // The *newest* 64, not the first: the client's own event floor means anything
    // dropped here is never re-sent, and the lines a player needs are the recent ones.
    this.broadcast('gameEvents', { version: this.game?.version ?? 0, events: events.slice(-64) });
  }

  private handleAction(
    connection: Connection,
    payload: {
      readonly action: GameAction;
      readonly requestId?: string;
      readonly turnToken?: { readonly currentPlayerId: string | null; readonly turnSeq: number };
    },
  ): void {
    if (connection.playerId === null) {
      return;
    }
    const seat = this.seatFor(connection.playerId);
    if (seat === undefined) {
      return;
    }
    /*
     * A request id already applied is answered, not re-applied. This is the whole
     * reason the record lives on the seat: a client that lost our answer re-sends
     * after reconnecting, and applying a `catchLastCard` twice is eight cards charged
     * for one call.
     */
    if (payload.requestId !== undefined && seat.lastRequestId === payload.requestId) {
      this.send(connection.socket, 'actionAccepted', {
        requestId: payload.requestId,
        version: seat.lastRequestVersion ?? this.record?.versionFloor ?? 0,
      });
      if (this.game !== null) {
        this.send(connection.socket, 'publicState', { state: toPublicGameState(this.game) });
        this.send(connection.socket, 'privateHand', { hand: toPrivateHandView(this.game, seat.playerId) });
      }
      return;
    }
    /*
     * A turn-scoped intent computed against a turn that has since moved on is refused
     * rather than applied. Replaying a stale one is the real danger: a card that was
     * legal three moves ago may be illegal now, or already played. A breaker
     * answering an open +3 is exempt even though it is a `playCard`, because the whole
     * point of that card is that it is played out of turn.
     */
    const token = payload.turnToken;
    const answeringBreaker = this.game?.plusThree != null && payload.action.type === 'playCard';
    if (
      token !== undefined &&
      !answeringBreaker &&
      TURN_SCOPED.has(payload.action.type) &&
      this.game !== null &&
      token.turnSeq !== this.game.turnSeq
    ) {
      this.rejectAction(connection, 'notYourTurn', payload.requestId);
      return;
    }
    this.applyAction(connection.playerId, payload.action, connection, payload.requestId);
  }

  /**
   * The one authoritative path, for every seat and every robot alike.
   *
   * `origin` changes nothing about what is legal — a robot is refused exactly what a
   * player would be refused. It changes only who is *told*: a robot's rejection goes
   * to the log, because there is no screen it belongs on.
   */
  private applyAction(
    playerId: string,
    action: GameAction,
    connection: Connection | null,
    requestId?: string,
    origin: 'player' | 'bot' = 'player',
  ): boolean {
    const record = this.record;
    if (record === null || this.game === null || record.phase !== 'inGame') {
      return false;
    }
    if (record.pausedBy !== null) {
      // A pause everybody can see is worth honouring, or it is decoration — and it
      // needs its own code, because telling a player the round is over when the table
      // is merely waiting is worse than saying nothing.
      this.rejectAction(connection, 'tablePaused', requestId, origin);
      return false;
    }
    /*
     * Two reasons a catch is refused before the engine sees it, both of them the
     * room's policy rather than the engine's rules: the engine knows nothing about
     * connections and nothing about clocks.
     *
     * An absent player cannot shout, so they cannot be caught out for silence.
     * Without this, absence turns a social rule into free farming — four cards an
     * orbit off somebody whose phone is rebooting. And a player who has just come
     * down to one card gets their head start. Both answer `nothingToCatch`: from the
     * caller's side there is nothing to catch *yet*.
     */
    if (action.type === 'catchLastCard') {
      const target = this.seatFor(action.targetId);
      // A seat a robot is playing *can* shout, so it is catchable like anybody else.
      // The exemption is for a chair nobody is sitting in.
      if (target !== undefined && !this.present(target) && !this.robotControls(target)) {
        this.rejectAction(connection, 'nothingToCatch', requestId, origin);
        return false;
      }
      if (this.withinLastCardGrace(action.targetId)) {
        this.rejectAction(connection, 'nothingToCatch', requestId, origin);
        return false;
      }
    }

    const result = applyCommand(this.game, buildCommand(playerId, action));
    if (!result.ok) {
      this.rejectAction(connection, result.rejection.code, requestId, origin);
      return false;
    }

    this.commit(result.state, result.events);
    const seat = this.seatFor(playerId);
    if (seat !== undefined && requestId !== undefined) {
      seat.lastRequestId = requestId;
      seat.lastRequestVersion = result.state.version;
      this.roomDirty = true;
    }
    /*
     * Acknowledged *after* the new table, not before. Acking first opens a window in
     * which the client's lock is released while its turn counter is still one behind,
     * and a move made inside it is refused as out of turn although it is legal.
     */
    if (connection !== null && requestId !== undefined) {
      this.send(connection.socket, 'actionAccepted', { requestId, version: result.state.version });
    }
    return true;
  }

  /** Answers one player, never the table: a rejection is nobody else's business. */
  private rejectAction(
    connection: Connection | null,
    code: RejectionCode,
    requestId?: string,
    origin: 'player' | 'bot' = 'player',
  ): void {
    if (origin === 'bot') {
      this.log('a robot move was refused', { code });
      return;
    }
    if (connection === null) {
      return;
    }
    this.send(connection.socket, 'actionRejected', {
      code,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  /** Everything that follows any accepted command, from any source. */
  private commit(state: GameState, events: readonly GameEvent[]): void {
    const record = this.record;
    if (record === null) {
      return;
    }
    this.game = state;
    this.gameDirty = true;
    this.trackLastCard();
    record.versionFloor = state.version;
    record.waitingSince = this.now();
    this.roomDirty = true;
    // The final table goes out *before* the phase change, so nobody renders the
    // end-of-round screen against the previous snapshot.
    this.broadcastGameState();
    this.emitEvents(events);
    if (state.phase === 'finished') {
      record.phase = 'finished';
      record.playAgainVotes = [];
      record.abandonVotes = [];
      record.pausedBy = null;
      this.autoVotePlayAgain();
      this.emitLobby();
      this.emitPlayAgain();
    } else {
      this.emitLobby();
    }
    this.bots.schedule();
  }

  /** Runs a command that is the room's own to issue: a skip, a departure, an abandon. */
  private applyRoomCommand(command: GameCommand): boolean {
    if (this.record?.phase !== 'inGame' || this.game === null) {
      return false;
    }
    const result = applyCommand(this.game, command);
    if (!result.ok) {
      this.log('a room command was refused', { command: command.type, code: result.rejection.code });
      return false;
    }
    this.commit(result.state, result.events);
    return true;
  }

  private startGame(): void {
    const record = this.record;
    if (record === null || record.phase === 'inGame' || record.seats.length < MIN_PLAYERS) {
      return;
    }
    const players: EnginePlayer[] = record.seats
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((seat) => ({ id: seat.playerId, name: seat.name }));

    const result = createGame(players, this.seedFactory(), record.versionFloor + 1, record.round);
    if (!result.ok) {
      this.log('could not deal a round', { code: result.rejection.code });
      return;
    }
    this.game = result.state;
    this.gameDirty = true;
    record.versionFloor = result.state.version;
    record.round += 1;
    record.phase = 'inGame';
    record.playAgainVotes = [];
    record.abandonVotes = [];
    record.pausedBy = null;
    record.waitingSince = this.now();
    for (const seat of record.seats) {
      seat.left = false;
      seat.skippedWhileAway = false;
      // A mis-tapped "leave" in one round must not cost this player their grace for
      // the rest of the evening.
      seat.saidGoodbye = false;
      // Every seat starts the round its own. A stand-in carried over from the last one
      // would hand a robot a hand nobody had asked it to play.
      seat.standIn = null;
      seat.standInSince = null;
      seat.standInDeclined = null;
      seat.robotPlayedThisRound = seat.bot;
    }
    this.roomDirty = true;
    this.trackLastCard();
    this.reseedBots();
    this.emitLobby();
    this.broadcastGameState();
    this.emitEvents(result.events);
    this.bots.schedule();
  }

  // --------------------------------------------------------- pause and votes

  private setPaused(by: string | null): void {
    const record = this.record;
    if (record === null || record.pausedBy === by) {
      return;
    }
    record.pausedBy = by;
    this.roomDirty = true;
    this.broadcast('paused', { pausedBy: by });
    this.emitLobby();
    // A hold stops the robots with everybody else, and letting go starts them again.
    this.bots.schedule();
  }

  private setAbandonVote(playerId: string, agree: boolean): void {
    const record = this.record;
    if (record === null || record.phase !== 'inGame') {
      return;
    }
    const votes = new Set(record.abandonVotes);
    if (agree) {
      votes.add(playerId);
    } else {
      votes.delete(playerId);
    }
    record.abandonVotes = [...votes];
    this.roomDirty = true;
    /*
     * Only the people. Stopping a round is a decision, and a robot has no view about
     * it — while a seat a robot is *standing in for* is by definition one nobody is
     * answering for, which is very often the reason the vote was called. Counting
     * either of them would let a robot veto the one escape hatch the table has.
     */
    const deciding = record.seats.filter(
      (seat) => this.present(seat) && !seat.left && !this.robotControls(seat),
    );
    const unanimous = deciding.length > 0 && deciding.every((seat) => votes.has(seat.playerId));
    this.emitLobby();
    if (!unanimous || this.game === null) {
      return;
    }
    /*
     * Ending a round by agreement is what a real table does when somebody has to go.
     * Nobody is marked as having left: the round ended, and the standings show exactly
     * where everyone was.
     */
    record.abandonVotes = [];
    this.applyRoomCommand({ type: 'abandonRound', playerId });
  }

  private handleNudge(connection: Connection, targetPlayerId: string): void {
    if (connection.playerId === null) {
      return;
    }
    const target = this.connectionForPlayer(targetPlayerId);
    if (target !== null) {
      this.send(target.socket, 'nudged', { fromPlayerId: connection.playerId });
    }
  }

  // ----------------------------------------------------------------- play again

  private handlePlayAgainVote(connection: Connection, agree: boolean): void {
    const record = this.record;
    if (connection.playerId === null || record === null || record.phase !== 'finished') {
      return;
    }
    const votes = new Set(record.playAgainVotes);
    if (agree) {
      votes.add(connection.playerId);
    } else {
      votes.delete(connection.playerId);
    }
    record.playAgainVotes = [...votes];
    this.roomDirty = true;
    this.maybeStartNextRound();
  }

  /**
   * How many people the next round is waiting on.
   *
   * People, not seats. A robot's agreement is recorded so it can never block a round,
   * but publishing it made the standings say "2 of 2 agreed" while nothing happened —
   * telling the one person still there that everybody was ready and then waiting for
   * them.
   */
  private requiredVotes(): number {
    return (this.record?.seats ?? []).filter((seat) => this.present(seat) && !this.robotControls(seat))
      .length;
  }

  /**
   * A robot always wants to play again.
   *
   * It has to: a robot is counted among the seats a new round needs the agreement of,
   * and a table with one would otherwise never get a second deal.
   */
  private autoVotePlayAgain(): void {
    const record = this.record;
    if (record === null) {
      return;
    }
    const votes = new Set(record.playAgainVotes);
    for (const seat of record.seats) {
      // Only seats whose agreement is counted. A stand-in for a seat that is *away* is
      // not in `requiredVotes`, and voting for it anyway put "2 of 1 ready" on screen.
      if (this.robotControls(seat) && this.present(seat)) {
        votes.add(seat.playerId);
      }
    }
    record.playAgainVotes = [...votes];
    this.roomDirty = true;
  }

  private emitPlayAgain(): void {
    const record = this.record;
    if (record === null) {
      return;
    }
    // Robot agreements are the room's bookkeeping, not a line on anybody's screen.
    const agreed = record.playAgainVotes.filter((playerId) => {
      const seat = this.seatFor(playerId);
      return seat !== undefined && !this.robotControls(seat);
    });
    this.broadcast('playAgainState', { agreed, required: this.requiredVotes() });
  }

  private maybeStartNextRound(): void {
    const record = this.record;
    if (record === null) {
      return;
    }
    this.emitPlayAgain();
    const here = record.seats.filter((seat) => this.present(seat));
    if (here.length < MIN_PLAYERS) {
      return;
    }
    const votes = new Set(record.playAgainVotes);
    if (!here.every((seat) => votes.has(seat.playerId))) {
      return;
    }
    /*
     * Only drop seats whose grace has actually run out. Splicing every absent seat the
     * moment a round ended destroyed the resume token a player needed ten seconds
     * later — and then answered their rejoin with `unknownSeat`, which is a dead end.
     */
    const cutoff = this.now() - SEAT_GRACE_MS;
    record.seats = record.seats.filter(
      (seat) => this.present(seat) || seat.absentSince === null || seat.absentSince >= cutoff,
    );
    this.resequenceSeats();
    if (record.seats.length < MIN_PLAYERS) {
      this.roomDirty = true;
      return;
    }
    record.playAgainVotes = [];
    record.phase = 'lobby';
    this.game = null;
    this.gameDirty = true;
    this.trackLastCard();
    this.roomDirty = true;
    this.startGame();
  }

  // -------------------------------------------------------------- lobby powers

  /**
   * A lobby power, authorised against the seat that holds them.
   *
   * The check is here and only here, which is the reason all ten arrive as one
   * message type. Note what it is *not*: it does not ask whether the sender is
   * serving the game, because nobody is — it asks whether they hold the creator
   * seat's credential.
   */
  private handleRoomCommand(connection: Connection, command: RoomCommand): void {
    const record = this.record;
    if (record === null || connection.playerId === null) {
      return;
    }
    if (connection.playerId !== this.creatorSeat()?.playerId) {
      this.log('refused a lobby command from a seat that does not hold them', { command: command.type });
      return;
    }
    switch (command.type) {
      case 'startGame':
        if (record.phase === 'lobby') {
          this.startGame();
        }
        return;
      case 'setMaxPlayers': {
        if (record.phase !== 'lobby') {
          return;
        }
        const clamped = Math.min(Math.max(command.maxPlayers, MIN_PLAYERS), MAX_PLAYERS);
        if (clamped < record.seats.length) {
          return;
        }
        record.maxPlayers = clamped;
        this.roomDirty = true;
        this.emitLobby();
        return;
      }
      case 'setTableLanguage':
        record.tableLanguage = command.language;
        this.roomDirty = true;
        this.emitLobby();
        return;
      case 'kickPlayer':
        this.kick(command.playerId);
        return;
      case 'addBot':
        this.addBot();
        return;
      case 'setStandInEnabled':
        this.setStandInEnabled(command.enabled);
        return;
      case 'standInNow':
        this.standInNow(command.playerId);
        return;
      case 'stopStandIn':
        this.stopStandIn(command.playerId);
        return;
      case 'skipAbsentTurn':
        this.skipAbsentTurn(command.playerId);
        return;
      case 'removeFromRound':
        this.removeFromRound(command.playerId);
        return;
    }
  }

  private kick(playerId: string): void {
    const record = this.record;
    if (record === null || record.phase !== 'lobby' || playerId === this.creatorSeat()?.playerId) {
      return;
    }
    const connection = this.connectionForPlayer(playerId);
    if (connection !== null) {
      this.send(connection.socket, 'kicked', { reason: 'removedByCreator' });
      connection.playerId = null;
      connection.socket.close(CLOSE_REJECTED, 'removed');
      this.connections.delete(connection.socket);
    }
    const index = record.seats.findIndex((seat) => seat.playerId === playerId);
    if (index >= 0) {
      record.seats.splice(index, 1);
      this.resequenceSeats();
      delete record.botRng[playerId];
    }
    this.roomDirty = true;
    this.emitLobby();
    this.bots.schedule();
  }

  /** Passes an absent player's turn, on the room's own authority. */
  private skipAbsentTurn(playerId: string): boolean {
    const seat = this.seatFor(playerId);
    if (seat === undefined || this.present(seat) || seat.left) {
      return false;
    }
    const applied = this.applyRoomCommand({ type: 'skipTurn', playerId });
    if (applied) {
      // Only after the engine has agreed. Latching the flag first drops this seat's
      // future grace to nought for ever on a rejection.
      seat.skippedWhileAway = true;
      this.roomDirty = true;
      this.log('passed an absent seat', { seat: seat.seat, name: seat.name });
    }
    return applied;
  }

  /** Takes a player out of the round, keeping their cards out of play. */
  private removeFromRound(playerId: string): boolean {
    const seat = this.seatFor(playerId);
    if (seat === undefined || seat.left) {
      return false;
    }
    const applied = this.applyRoomCommand({ type: 'leaveGame', playerId });
    if (applied) {
      // Marked only once the engine has agreed, or the lobby would say a seat had left
      // while the engine kept dealing it turns.
      seat.left = true;
      // A seat that has left is not a seat to play: the engine refuses every command
      // from it, so a robot left pointing at it would ask for ever.
      this.endStandIn(seat);
      this.roomDirty = true;
      this.emitLobby();
      this.bots.schedule();
    }
    return applied;
  }

  // ------------------------------------------------------------------- robots

  /** Advances one robot's own random stream. */
  private botRandom(playerId: string): number {
    const record = this.record;
    if (record === null) {
      return 0.5;
    }
    const seed = record.botRng[playerId] ?? seedFromString(`${this.roomCode}:${playerId}`);
    const next = nextFloat(createRng(seed));
    record.botRng[playerId] = next.state.seed;
    this.roomDirty = true;
    return next.value;
  }

  /** Starts every robot's stream again, so a round is reproducible from its deal. */
  private reseedBots(): void {
    const record = this.record;
    if (record === null) {
      return;
    }
    record.botRng = {};
    for (const seat of record.seats) {
      record.botRng[seat.playerId] = seedFromString(
        `${this.roomCode}:${String(record.round)}:${seat.playerId}`,
      );
    }
    this.roomDirty = true;
  }

  /**
   * Seats a robot. Lobby only, and never mid-round.
   *
   * A round is dealt to the seats it starts with: adding a player of any kind to a
   * table in play would mean dealing a hand out of a pile already in use, and the
   * engine has no such transition.
   */
  private addBot(): boolean {
    const record = this.record;
    if (record === null || record.phase !== 'lobby' || record.seats.length >= record.maxPlayers) {
      return false;
    }
    const seat = freshSeat({
      playerId: createPlayerId(),
      name: robotName(
        record.tableLanguage,
        record.seats.map((existing) => existing.name),
      ),
      seat: record.seats.length,
      bot: true,
      robotPlayedThisRound: true,
    });
    record.seats.push(seat);
    this.roomDirty = true;
    this.log('robot seated', { name: seat.name });
    this.emitLobby();
    return true;
  }

  private setStandInEnabled(enabled: boolean): void {
    const record = this.record;
    if (record === null || record.standInEnabled === enabled) {
      return;
    }
    record.standInEnabled = enabled;
    if (!enabled) {
      // Switching it off hands every seat straight back; leaving robots playing after
      // the table said no would make the setting a suggestion.
      for (const seat of record.seats) {
        this.endStandIn(seat);
      }
    }
    this.roomDirty = true;
    this.emitLobby();
    this.bots.schedule();
  }

  /**
   * Puts a robot on somebody's seat now, on the creator's say-so.
   *
   * Its own consent: an explicit choice by the person running the table does not need
   * the table-wide setting as well, and it is the answer to "we are not waiting
   * another thirty seconds for this".
   */
  private standInNow(playerId: string): boolean {
    const seat = this.seatFor(playerId);
    if (
      seat === undefined ||
      seat.bot ||
      seat.left ||
      seat.standIn !== null ||
      this.record?.phase !== 'inGame'
    ) {
      return false;
    }
    if (this.present(seat)) {
      /*
       * A seat that is here and answering is not the creator's to give away. The
       * control exists for somebody who has stopped responding, so it needs the table
       * to have actually been waiting on them — otherwise one mis-tap takes a playing
       * player's hand off them mid-turn.
       *
       * This seat's own clock, not the table's: `waitingSince` is reset by anybody's
       * move, so a seat silent for ten minutes while the others played around it could
       * not be covered — which is exactly the seat this is for.
       */
      const silentSince = seat.lastIntentAt ?? this.record.waitingSince ?? 0;
      if (silentSince === 0 || this.now() - silentSince < IDLE_TURN_NUDGE_MS) {
        return false;
      }
    }
    this.beginStandIn(seat, this.present(seat) ? 'idle' : 'absent');
    return true;
  }

  /**
   * Hands a seat back to its owner, whether or not they have said anything.
   *
   * And remembers that it was asked for. A stand-in that restarted on the next sweep
   * made the control a lie, and — because a covered seat is not offered the
   * absent-seat controls — left the table with no way to stop a robot at all.
   */
  private stopStandIn(playerId: string): boolean {
    const seat = this.seatFor(playerId);
    if (seat === undefined || seat.standIn === null) {
      return false;
    }
    // About the kind that was actually running, and nothing else.
    seat.standInDeclined = seat.standIn;
    this.endStandIn(seat);
    this.roomDirty = true;
    this.emitLobby();
    this.bots.schedule();
    return true;
  }

  private beginStandIn(seat: SeatRecord, why: 'absent' | 'idle'): void {
    const record = this.record;
    if (record === null || seat.bot || seat.left || seat.standIn !== null) {
      return;
    }
    seat.standIn = why;
    /*
     * The table starts waiting for the *robot* now, and its patience has to start now
     * too: the stall watchdog would otherwise inherit however long the seat had
     * already been silent — by definition longer than the deadline — and pass the turn
     * immediately, before the robot had a moment.
     *
     * Only for the seat actually on turn, though. `waitingSince` is the table's clock,
     * not this seat's: resetting it while covering somebody else would push out
     * another seat's skip grace, the nudge, and the countdown every client is shown.
     */
    seat.standInSince = this.now();
    seat.robotPlayedThisRound = true;
    if (this.game !== null && currentPlayer(this.game)?.id === seat.playerId) {
      record.waitingSince = this.now();
    }
    record.botRng[seat.playerId] ??= seedFromString(
      `${this.roomCode}:${String(record.round)}:${seat.playerId}`,
    );
    this.roomDirty = true;
    this.log('a robot is playing a seat', { why, seat: seat.seat, name: seat.name });
    this.emitLobby();
    this.bots.schedule();
  }

  /** Ends a stand-in. The caller owns telling the table; several callers batch it. */
  private endStandIn(seat: SeatRecord): boolean {
    if (seat.standIn === null) {
      return false;
    }
    seat.standIn = null;
    seat.standInSince = null;
    this.roomDirty = true;
    /*
     * And takes the robot's answer back with it. A stand-in agrees to play again on
     * the seat's behalf, because a table with one could never deal a second round
     * otherwise — but the moment its owner is back, that agreement is theirs to give.
     * Leaving it behind dealt people into rounds they were never asked about.
     */
    const record = this.record;
    if (record !== null && record.phase === 'finished' && record.playAgainVotes.includes(seat.playerId)) {
      record.playAgainVotes = record.playAgainVotes.filter((id) => id !== seat.playerId);
      this.emitPlayAgain();
    }
    return true;
  }

  /**
   * A robot's move, through the one authoritative path every move goes through.
   *
   * A refused move is *not* retried and buys no privilege. The most a robot gets is
   * what any player in that position has: if its own idea of the turn was refused, it
   * pays a card from the pile, which ends the turn. Nothing here can free-skip — that
   * is the room's own backstop, on an alarm, and it is a bug when it fires.
   */
  private submitBotMove(playerId: string, move: BotMove): boolean {
    const seat = this.seatFor(playerId);
    if (seat === undefined || !this.robotControls(seat)) {
      return false;
    }
    if (this.applyAction(playerId, move.action, null, undefined, 'bot')) {
      return true;
    }
    if (move.kind !== 'turn' || move.action.type === 'drawCard') {
      return false;
    }
    return this.applyAction(playerId, { type: 'drawCard' }, null, undefined, 'bot');
  }

  // ------------------------------------------------------------------- alarms

  /**
   * Books every deadline the current state implies, and clears the rest.
   *
   * Recomputed from scratch after anything changes rather than nudged incrementally,
   * and that is the design: an incremental scheme has to remember to *clear* on every
   * path that invalidates a deadline, which is where the host's equivalent logic went
   * wrong repeatedly. This is idempotent — running it twice books the same thing — so
   * the only way to get it wrong is to compute the wrong deadline, not to forget a
   * path.
   *
   * `botMove` is the one exception, owned by `BotRunner` through its schedule seam:
   * only the runner knows what a robot has decided to do and how long it drew.
   */
  /**
   * Books a deadline, never in the past. See {@link ALARM_FLOOR_MS}.
   *
   * Every deadline `reschedule` computes goes through here, rather than only the ones
   * that look risky: a floor that applies to some kinds and not others is a floor
   * somebody has to remember to apply.
   */
  private book(kind: AlarmKind, atMs: number): void {
    this.alarms.set(kind, Math.max(atMs, this.now() + ALARM_FLOOR_MS));
  }

  private reschedule(): void {
    const record = this.record;
    if (record === null) {
      this.alarms.clearAll();
      return;
    }
    const now = this.now();

    /*
     * --- the room's own lifetime, and whether anything else is worth doing at all
     *
     * An empty room does nothing but wait. Everything below this line — passing an
     * absent seat's turn, offering a nudge, putting a robot on a chair — exists to
     * keep a table moving *for the people at it*, and with nobody connected there is
     * nobody it could be moving for.
     *
     * Left ungated this is not merely wasteful, it is a bill: two players who both
     * close their tabs leave a round where the seat on turn is always absent, so the
     * room passes it, which makes the next absent seat the one on turn, and it passes
     * that too — a skip every twelve seconds for six hours, on a plan whose whole
     * appeal is that an idle room costs nothing. The table is exactly where they left
     * it when somebody comes back, which is the promise; grinding through it in an
     * empty room is not part of that promise.
     */
    const watched = this.liveConnectionCount > 0;
    if (!watched) {
      // A returning player cancels this by saying hello; the alarm firing means
      // nobody did for the whole TTL.
      this.book('ttl', now + ROOM_IDLE_TTL_MS);
      for (const kind of [
        'absentTurn',
        'botStall',
        'botMove',
        'standIn',
        'lastCard',
        'idleNudge',
        'seatGrace',
      ] as AlarmKind[]) {
        this.alarms.clear(kind);
      }
      return;
    }
    this.alarms.clear('ttl');

    // --- seats being held
    const graceMs = record.phase === 'lobby' ? LOBBY_GRACE_MS : SEAT_GRACE_MS;
    let earliestGrace: number | null = null;
    for (const seat of record.seats) {
      if (seat.bot || this.present(seat) || seat.absentSince === null) {
        continue;
      }
      const at = seat.absentSince + graceMs;
      earliestGrace = earliestGrace === null ? at : Math.min(earliestGrace, at);
    }
    if (earliestGrace === null) {
      this.alarms.clear('seatGrace');
    } else {
      this.book('seatGrace', earliestGrace);
    }

    // --- everything that only means something during a live, unpaused round
    const live = record.phase === 'inGame' && this.game !== null && record.pausedBy === null;
    if (!live) {
      /*
       * `botMove` is cleared here too, even though `BotRunner` owns it everywhere else.
       * The runner cancels its own pause when `blocked()` turns true — but only if this
       * instance is the one that armed it, and after a hibernation it is not: the alarm
       * row survived in storage and the runner came back with nothing pending. Left
       * alone, a paused table would wake to play a card.
       */
      for (const kind of [
        'absentTurn',
        'botStall',
        'botMove',
        'standIn',
        'lastCard',
        'idleNudge',
      ] as AlarmKind[]) {
        this.alarms.clear(kind);
      }
      return;
    }
    const game = this.game as GameState;

    this.scheduleTurnDeadlines(record, game, now);
    this.scheduleStandIn(record);
    this.scheduleLastCard(record, now);
  }

  /** The absent-turn skip, the robot stall, and the nudge — all keyed on whose turn it is. */
  private scheduleTurnDeadlines(record: RoomRecord, game: GameState, now: number): void {
    this.alarms.clear('absentTurn');
    this.alarms.clear('botStall');
    this.alarms.clear('idleNudge');

    /*
     * Collected and booked as a minimum rather than assigned per seat. `set` replaces,
     * so a loop that books inside it lets the *last* seat considered decide the
     * deadline — which for a +3 waiting on three seats means the room wakes for
     * whichever one happens to be last in the array rather than whichever is due first.
     */
    let absentTurnAt: number | null = null;
    let botStallAt: number | null = null;
    const soonest = (current: number | null, candidate: number): number =>
      current === null ? candidate : Math.min(current, candidate);

    /*
     * The +3 window first, and without any grace, because it is the worst stall in the
     * game and the one a turn-based check cannot see: while a +3 is open the seat on
     * turn is the player who *played* it, and every command from every other seat is
     * refused. If the seats being waited on are away, the table is frozen and nothing
     * about the current player says so.
     */
    const pending = game.plusThree;
    if (pending !== null) {
      for (const awaited of pending.awaiting) {
        const seat = this.seatFor(awaited);
        if (seat === undefined) {
          continue;
        }
        if (this.robotControls(seat)) {
          const since = Math.max(record.waitingSince ?? 0, seat.standInSince ?? 0);
          if (since > 0) {
            botStallAt = soonest(botStallAt, since + BOT_STALL_MS);
          }
          continue;
        }
        if (!this.present(seat)) {
          // Nothing to wait for: decline for them at once.
          absentTurnAt = soonest(absentTurnAt, now);
          continue;
        }
        /*
         * And the case that froze a table indefinitely: a seat that is *here* and
         * tapping nothing. The turn-based check cannot see it, so this window needs its
         * own deadline.
         */
        const silentSince = Math.max(record.waitingSince ?? 0, seat.lastIntentAt ?? 0);
        if (silentSince > 0) {
          absentTurnAt = soonest(absentTurnAt, silentSince + STAND_IN_IDLE_MS);
        }
      }
      this.bookIfSet('absentTurn', absentTurnAt);
      this.bookIfSet('botStall', botStallAt);
      return;
    }

    const onTurn = currentPlayer(game);
    if (onTurn === null) {
      return;
    }
    const seat = this.seatFor(onTurn.id);
    if (seat === undefined || seat.left) {
      return;
    }
    if (this.robotControls(seat)) {
      // A robot is playing this seat. Its own backstop is the stall deadline; the
      // absence machinery has nothing to add and must not skip a seat being played.
      const from = Math.max(record.waitingSince ?? 0, seat.standInSince ?? 0);
      if (from > 0) {
        this.book('botStall', from + BOT_STALL_MS);
      }
      return;
    }
    if (this.present(seat)) {
      // A present player thinking. Offer the others the nudge once it has been a while.
      if (record.waitingSince !== null) {
        this.book('idleNudge', record.waitingSince + IDLE_TURN_NUDGE_MS);
      }
      return;
    }

    /*
     * Measured from the later of "it became their turn" and "they went away". Keying it
     * on the last accepted move alone was wrong in the commonest case of all: a player
     * on turn who thinks for longer than the grace and *then* drops would be skipped
     * on the first tick that noticed, so the window was nought.
     */
    const grace = seat.skippedWhileAway || seat.saidGoodbye ? 0 : ABSENT_TURN_GRACE_CLOSED_MS;
    const waitingFrom = Math.max(record.waitingSince ?? 0, seat.absentSince ?? 0);
    let at = waitingFrom > 0 ? waitingFrom + grace : now;
    if (seat.lastResumeAttemptAt !== null) {
      /*
       * They are visibly trying to come back. That is much stronger evidence than
       * silence is of the opposite, and it costs nothing to wait for — so the deadline
       * moves out rather than the skip being cancelled by a flag somebody has to
       * remember to clear.
       */
      at = Math.max(at, seat.lastResumeAttemptAt + RESUME_ATTEMPT_SUPPRESSES_SKIP_MS);
    }
    this.book('absentTurn', at);
  }

  /** Books a deadline only when one was computed. */
  private bookIfSet(kind: AlarmKind, atMs: number | null): void {
    if (atMs !== null) {
      this.book(kind, atMs);
    }
  }

  /**
   * When a robot may take a seat over.
   *
   * Swept across every seat rather than checked when its turn comes round, which was
   * the first version and was wrong: a seat that has been skipped once is skipped
   * again the instant its turn arrives, so the only moment the check could fire was
   * the one moment it was always too early for. A seat is also more than its turn — a
   * +3 to answer, a last card to declare — and a robot that only woke on turn would
   * sit through all of it.
   */
  private scheduleStandIn(record: RoomRecord): void {
    if (!record.standInEnabled) {
      this.alarms.clear('standIn');
      return;
    }
    let earliest: number | null = null;
    const consider = (at: number): void => {
      earliest = earliest === null ? at : Math.min(earliest, at);
    };
    for (const seat of record.seats) {
      if (seat.bot || seat.left || seat.standIn !== null) {
        continue;
      }
      if (!this.present(seat)) {
        if (
          seat.standInDeclined === 'absent' ||
          // A goodbye is a decision. Playing the hand of somebody who said they were
          // done is not a favour, and their seat is still theirs to come back to.
          seat.saidGoodbye ||
          seat.absentSince === null
        ) {
          continue;
        }
        let at = seat.absentSince + STAND_IN_ABSENT_MS;
        if (seat.lastResumeAttemptAt !== null) {
          at = Math.max(at, seat.lastResumeAttemptAt + RESUME_ATTEMPT_SUPPRESSES_SKIP_MS);
        }
        consider(at);
        continue;
      }
      /*
       * A seat that is here and silent, and only while the table is actually waiting
       * on it. Both clocks have to be old: the table has been waiting this long *and*
       * nothing has been asked for from that seat in that time. An open socket is not
       * an answer — a phone in a pocket keeps one perfectly.
       */
      if (seat.standInDeclined === 'idle' || this.waiting().playerId !== seat.playerId) {
        continue;
      }
      const silentSince = Math.max(record.waitingSince ?? 0, seat.lastIntentAt ?? 0);
      if (silentSince > 0) {
        consider(silentSince + STAND_IN_IDLE_MS);
      }
    }
    if (earliest === null) {
      this.alarms.clear('standIn');
    } else {
      this.book('standIn', earliest);
    }
  }

  /**
   * When the head start on a last card runs out.
   *
   * The window itself is enforced by comparison, in `withinLastCardGrace` — this alarm
   * exists only so a *robot* looks again at the moment it shuts. A human's screen
   * already has a button that starts working; a robot decides once per state version
   * and would otherwise never revisit a catch it was too early for.
   */
  private scheduleLastCard(record: RoomRecord, now: number): void {
    let earliest: number | null = null;
    for (const since of Object.values(record.lastCardSince)) {
      const at = since + LAST_CARD_GRACE_MS;
      if (at > now && (earliest === null || at < earliest)) {
        earliest = at;
      }
    }
    if (earliest === null) {
      this.alarms.clear('lastCard');
    } else {
      this.book('lastCard', earliest);
    }
  }

  /**
   * A deadline came round. Returns `true` when the room asked to be forgotten.
   *
   * The adapter is what does the forgetting, because deleting the object's storage is
   * the platform's business and this class only ever speaks to `RoomStore`.
   */
  handleAlarm(): boolean {
    const now = this.now();
    let forget = false;
    for (const kind of this.alarms.due(now)) {
      switch (kind) {
        case 'ttl':
          if (this.liveConnectionCount === 0) {
            forget = true;
          }
          break;
        case 'standIn':
          this.sweepStandIns(now);
          break;
        case 'absentTurn':
          this.passAbsentTurn();
          break;
        case 'botStall':
          this.passStalledRobot(now);
          break;
        case 'botMove':
          this.bots.pump();
          break;
        case 'lastCard':
          // Nothing to do but look again: the window has shut, so a robot that was
          // too early to call somebody out may now be in time.
          this.bots.schedule();
          break;
        case 'idleNudge':
          /*
           * One extra lobby snapshot, at the moment the threshold is crossed.
           *
           * The nudge is offered when `sentAt - waitingSince` passes the threshold, and
           * both are the room's own readings — which is what makes it immune to clock
           * skew, and also what made it unreachable before: the only snapshot carrying
           * a new `waitingSince` was the one built in the same breath that set it, so
           * the difference every client ever saw was zero.
           */
          this.emitLobby();
          break;
        case 'seatGrace':
          this.sweepSeatGrace(now);
          break;
      }
    }
    if (forget) {
      this.alarms.clearAll();
      return true;
    }
    this.flush();
    return false;
  }

  /** The seat on turn is not there, or a +3 window is waiting on somebody who is not. */
  private passAbsentTurn(): void {
    const game = this.game;
    if (game === null || this.record?.phase !== 'inGame' || this.record.pausedBy !== null) {
      return;
    }
    const pending = game.plusThree;
    if (pending !== null) {
      for (const awaited of pending.awaiting) {
        const seat = this.seatFor(awaited);
        if (seat === undefined || this.robotControls(seat)) {
          continue;
        }
        if (!this.present(seat)) {
          // Declining for them produces exactly what a present player's decline
          // produces, and — deliberately — no event naming who held a breaker.
          this.applyRoomCommand({ type: 'passBreak', playerId: awaited });
          return;
        }
        const silentSince = Math.max(this.record.waitingSince ?? 0, seat.lastIntentAt ?? 0);
        if (silentSince > 0 && this.now() - silentSince >= STAND_IN_IDLE_MS) {
          if (this.record.standInEnabled && seat.standInDeclined !== 'idle') {
            this.beginStandIn(seat, 'idle');
          } else {
            this.log('a +3 window went unanswered; declining for the seat');
            this.applyRoomCommand({ type: 'passBreak', playerId: awaited });
          }
          return;
        }
      }
      return;
    }
    const onTurn = currentPlayer(game);
    if (onTurn === null) {
      return;
    }
    const seat = this.seatFor(onTurn.id);
    if (seat === undefined || seat.left || this.present(seat) || this.robotControls(seat)) {
      return;
    }
    this.skipAbsentTurn(onTurn.id);
  }

  /**
   * The backstop for a robot that did not move.
   *
   * Nothing else would ever rescue this. A robot cannot be absent, so no grace, no
   * hold and no vacate applies to it — and a lost alarm or a bug in the driver would
   * leave the round stopped with nothing on any screen to explain why. The seat is
   * passed exactly as an absent player's is, and the fact is logged, because a table
   * that needs this has found a bug.
   */
  private passStalledRobot(now: number): void {
    const record = this.record;
    const game = this.game;
    if (record === null || game === null || record.phase !== 'inGame' || record.pausedBy !== null) {
      return;
    }
    const pending = game.plusThree;
    if (pending !== null) {
      for (const awaited of pending.awaiting) {
        const seat = this.seatFor(awaited);
        if (seat === undefined || !this.robotControls(seat)) {
          continue;
        }
        const since = Math.max(record.waitingSince ?? 0, seat.standInSince ?? 0);
        if (since > 0 && now - since >= BOT_STALL_MS) {
          this.log('a robot did not answer a +3; declining for it');
          this.applyRoomCommand({ type: 'passBreak', playerId: awaited });
          return;
        }
      }
      return;
    }
    const onTurn = currentPlayer(game);
    if (onTurn === null) {
      return;
    }
    const seat = this.seatFor(onTurn.id);
    if (seat === undefined || !this.robotControls(seat)) {
      return;
    }
    const from = Math.max(record.waitingSince ?? 0, seat.standInSince ?? 0);
    if (from === 0 || now - from < BOT_STALL_MS) {
      return;
    }
    this.log('a robot did not move; passing the seat', { seat: seat.seat });
    this.applyRoomCommand({ type: 'skipTurn', playerId: onTurn.id });
  }

  private sweepStandIns(now: number): void {
    const record = this.record;
    if (record === null || !record.standInEnabled || record.phase !== 'inGame' || record.pausedBy !== null) {
      return;
    }
    for (const seat of record.seats) {
      if (seat.bot || seat.left || seat.standIn !== null) {
        continue;
      }
      if (
        seat.lastResumeAttemptAt !== null &&
        now - seat.lastResumeAttemptAt < RESUME_ATTEMPT_SUPPRESSES_SKIP_MS
      ) {
        // Visibly on their way back. Taking the seat over now would hand them a hand
        // that had been played for them in the seconds before they arrived.
        continue;
      }
      if (!this.present(seat)) {
        if (
          seat.standInDeclined === 'absent' ||
          seat.saidGoodbye ||
          seat.absentSince === null ||
          now - seat.absentSince < STAND_IN_ABSENT_MS
        ) {
          continue;
        }
        this.beginStandIn(seat, 'absent');
        continue;
      }
      if (seat.standInDeclined === 'idle' || this.waiting().playerId !== seat.playerId) {
        continue;
      }
      const silentSince = Math.max(record.waitingSince ?? 0, seat.lastIntentAt ?? 0);
      if (silentSince === 0 || now - silentSince < STAND_IN_IDLE_MS) {
        continue;
      }
      this.beginStandIn(seat, 'idle');
    }
  }

  /**
   * Frees a seat whose grace has run out.
   *
   * In the lobby a seat is removed outright — nothing is at stake and the chair is
   * worth more to somebody who is here. Mid-round it is *not*: the seat stays, marked
   * absent, because its cards are in play and its owner may still come back. What the
   * grace running out changes mid-round is only that the seat becomes droppable when
   * the round ends, which `maybeStartNextRound` already checks.
   */
  private sweepSeatGrace(now: number): void {
    const record = this.record;
    if (record === null || record.phase !== 'lobby') {
      return;
    }
    const before = record.seats.length;
    record.seats = record.seats.filter(
      (seat) =>
        seat.bot ||
        this.present(seat) ||
        seat.absentSince === null ||
        now - seat.absentSince <= LOBBY_GRACE_MS,
    );
    if (record.seats.length !== before) {
      this.resequenceSeats();
      this.roomDirty = true;
      this.emitLobby();
    }
  }

  // ------------------------------------------------------------- test seams

  /**
   * Test seam: forces one seat's hand to a given size.
   *
   * Some rules only engage at a specific hand size — "last card" being the obvious one
   * — and a test that cannot reach that state ends up asserting that the engine
   * refuses an illegal move, which it would with the feature deleted.
   *
   * The cards it takes off the hand go back under the draw pile rather than out of
   * existence, so the deck-conservation invariant every absence test checks still
   * holds.
   */
  forceHandForTests(playerId: string, size: number): void {
    const game = this.game;
    if (game === null) {
      return;
    }
    const hand = game.hands[playerId] ?? [];
    if (size >= hand.length) {
      return;
    }
    this.mutateForTests({
      hands: { ...game.hands, [playerId]: hand.slice(0, size) },
      drawPile: [...game.drawPile, ...hand.slice(size)],
    });
  }

  /** Test seam: opens a breaker window that is waiting on one seat. */
  forcePlusThreeForTests(byPlayerId: string, awaitedPlayerId: string): void {
    if (this.game === null) {
      return;
    }
    this.mutateForTests({ plusThree: { playerId: byPlayerId, awaiting: [awaitedPlayerId] } });
  }

  /**
   * The one place a seam may write authoritative state.
   *
   * Everything that reaches a client goes through the same steps as a real command —
   * the version advances and the floor moves with it — so a forced situation is
   * indistinguishable from a played one, and no test can pass because of a shortcut
   * the game itself does not have.
   */
  private mutateForTests(patch: Partial<GameState>): void {
    if (this.game === null) {
      return;
    }
    this.commit({ ...this.game, ...patch, version: this.game.version + 1 }, []);
  }

  /** Test and diagnostic seam: the room as stored. */
  snapshotForTests(): { room: RoomRecord | null; game: GameState | null } {
    return { room: this.record, game: this.game };
  }
}
