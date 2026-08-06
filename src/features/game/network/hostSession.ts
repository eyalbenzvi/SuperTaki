import { record } from '../../../lib/diagnostics.ts';
import { createPlayerId, createResumeToken, randomHex, randomInt } from '../../../lib/id.ts';
import { onSleep, onWake } from '../../../lib/lifecycle.ts';
import { createLogger } from '../../../lib/logger.ts';
import { sanitizeDisplayName, uniquifyDisplayName } from '../../../lib/sanitize.ts';
import { robotName } from '../bot/names.ts';
import { BotRunner, type CancelPause } from '../bot/runner.ts';
import type { BotMove, BotMoveKind } from '../bot/policy.ts';
import { botViewFor } from '../bot/view.ts';
import { applyCommand, createGame, currentPlayer } from '../engine/engine.ts';
import { createRng, nextFloat, seedFromString, type RngState } from '../engine/prng.ts';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type EnginePlayer,
  type GameCommand,
  type GameEvent,
  type GameState,
  type RejectionCode,
} from '../engine/state.ts';
import { toPrivateHandView, toPublicGameState } from '../engine/views.ts';
import { MessageDeduplicator, hostMessage, type MessageContext } from './envelope.ts';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ConnectionHealth,
  type GameAction,
  type HostMessage,
  type JoinRejectionReason,
  type LobbyPlayer,
  type LobbySnapshot,
} from './protocol.ts';
import { sessionError, type Session, type SessionClosedReason, type SessionObserver } from './session.ts';
import {
  ABSENT_TURN_GRACE_CLOSED_MS,
  ABSENT_TURN_GRACE_UNSTABLE_MS,
  BOT_STALL_MS,
  CHANNEL_DEAD_MS,
  HANDOFF_TIMEOUT_MS,
  HOST_SELF_DEMOTE_MS,
  IDLE_TURN_NUDGE_MS,
  LAST_CARD_GRACE_MS,
  LOBBY_GRACE_MS,
  RESUME_ATTEMPT_SUPPRESSES_SKIP_MS,
  SEAT_GRACE_MS,
  STAND_IN_ABSENT_MS,
  STAND_IN_IDLE_MS,
  UNSTABLE_AFTER_MISSES,
  probeInterval,
  silentAfterMs,
} from './timing.ts';
import { ProbeTracker, createWatchdog, type Watchdog } from './watchdog.ts';
import type { SignallingState, Transport, TransportConnection } from './transport.ts';

const log = createLogger('host');

interface Seat {
  playerId: string;
  name: string;
  seat: number;
  isHost: boolean;
  resumeToken: string;
  peerId: string | null;
  lastSeenAt: number;
  health: ConnectionHealth;
  /** Host clock at which this seat went quiet, or `null` while it is present. */
  absentSince: number | null;
  /** True once this seat has left the round for good. */
  left: boolean;
  /** When this seat last *tried* to come back — far better evidence than silence. */
  lastResumeAttemptAt: number | null;
  /**
   * A seat with no device behind it: a robot the table added on purpose.
   *
   * It is always present, is never probed, and none of the machinery that holds,
   * skips or vacates an absent seat applies to it — there is nobody to wait for.
   */
  bot: boolean;
  /**
   * Set while a robot is playing a *human's* seat, and why.
   *
   * Nothing else about the seat changes: the credential, the resume token and the
   * name stay exactly as they were, and the moment its owner speaks they have it
   * back. A stand-in is a favour the table does somebody, not a removal.
   */
  standIn: 'absent' | 'idle' | null;
  /**
   * When this seat last asked for something a human has to ask for.
   *
   * Deliberately *not* `lastSeenAt`. A phone in a pocket answers every heartbeat
   * perfectly, so silence on the wire proves nothing about whether anybody is
   * looking — and keying "they are not answering" on a clock that a `pong` resets
   * would have made the idle stand-in release itself every five seconds.
   */
  lastIntentAt: number | null;
  /** Whether this seat has already been skipped once without returning. */
  skippedWhileAway: boolean;
  /**
   * The kind of stand-in the table has stopped on this seat, or `null`.
   *
   * Without it, "stop the robot" was undone by the very next heartbeat: the sweeps
   * that start a stand-in key on how long the seat has been away or quiet, and
   * neither changes when somebody says no.
   *
   * It records *which* kind was refused, because the two are different decisions. A
   * table that stops a robot covering somebody's silence has said nothing about what
   * should happen when that person's phone actually dies — and an untyped flag
   * silently disabled absence cover for the rest of the round.
   */
  standInDeclined: 'absent' | 'idle' | null;
  /** Whether a robot played this seat at any point in the current round. */
  robotPlayedThisRound: boolean;
  /**
   * When the current stand-in began.
   *
   * The stall deadline is measured from this rather than from the table's own
   * `waitingSince`, which during a +3 belongs to the seat that played the card and is
   * by then already older than the deadline — so a robot that had just been given the
   * seat was given no time at all to answer.
   */
  standInSince: number | null;
  /**
   * Set when the player said goodbye rather than merely going quiet.
   *
   * It shortens the wait before their turn is passed — there is nothing to wait
   * for — but it deliberately does *not* take them out of the round. Marking a
   * seat as gone destroys its resume credential, and a player who taps "leave" and
   * changes their mind, or whose two-player table would otherwise be abandoned on
   * the spot, deserves the same way back as anybody else.
   */
  saidGoodbye: boolean;
  /**
   * The last intent accepted from this seat, and the version it produced.
   *
   * Kept on the seat rather than the connection, so it survives a reconnect —
   * which is the only case it exists for. A per-connection record was reset on
   * every attach and therefore could never recognise the replay it was meant to
   * catch.
   */
  lastRequestId: string | null;
  lastRequestVersion: number | null;
  probes: ProbeTracker;
}

interface ConnectionRecord {
  connection: TransportConnection;
  playerId: string | null;
  dedup: MessageDeduplicator;
  /** The protocol version this peer last spoke, so we can answer in it. */
  protocolVersion: number;
  unsubscribe: () => void;
}

/**
 * Rejection codes that did not exist before protocol 4, and what to say instead.
 *
 * An optional *field* is safely ignored by an older reader; a new *value* in an
 * enum is not — it fails the schema and takes the whole message down with it, so
 * the player's table stays locked until the backstop timer and their action is
 * replayed on the next reconnect. `notYourTurn` is the closest thing a version-3
 * vocabulary has to "you cannot act right now", and unlike the alternative it does
 * not claim the round has ended.
 */
const CODES_ADDED_IN_V4: Readonly<Partial<Record<RejectionCode, RejectionCode>>> = {
  tablePaused: 'notYourTurn',
  nothingToSkip: 'notYourTurn',
  alreadyLeft: 'unknownPlayer',
};

/**
 * Turns a requested action into an engine command.
 *
 * The player id comes from the connection, never from the message: that is the
 * whole of the authorisation model. Every field an action carries beyond its type
 * is copied out explicitly, so a new action cannot reach the engine by accident —
 * and `skipTurn` and `leaveGame` are unreachable from here by construction, which
 * is what keeps them host-only.
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

/** Everything needed to put a room back together on the same device. */
export interface HostRestoreState {
  readonly hostPlayerId: string;
  readonly phase: LobbySnapshot['phase'];
  readonly maxPlayers: number;
  readonly tableLanguage: 'he' | 'en';
  readonly versionFloor: number;
  readonly round: number;
  readonly seats: readonly {
    readonly playerId: string;
    readonly name: string;
    readonly seat: number;
    readonly isHost: boolean;
    readonly resumeToken: string;
    readonly left?: boolean;
    /** A robot seat. Travels with the room, or the seat comes back unfillable. */
    readonly bot?: boolean;
    readonly lastRequestId?: string | null;
    readonly lastRequestVersion?: number | null;
  }[];
  /** Whether the table lets a robot play for somebody who is not answering. */
  readonly standInEnabled?: boolean;
  readonly game: GameState | null;
}

export interface HostSessionOptions {
  readonly transport: Transport;
  readonly roomCode: string;
  readonly hostDisplayName: string;
  readonly maxPlayers: number;
  readonly tableLanguage: 'he' | 'en';
  readonly observer: SessionObserver;
  /**
   * Whether a robot may play a seat nobody is answering for. Defaults to on: a
   * table that has been skipping the same seat for three orbits has stopped being
   * a game, and the seat's owner gets it back the instant they speak.
   */
  readonly standInEnabled?: boolean;
  readonly now?: () => number;
  readonly seedFactory?: () => number;
  readonly heartbeatIntervalMs?: number;
  /** Rebuilds a room this device was already hosting. */
  readonly restore?: HostRestoreState;
  /** Called whenever the room state changes, so it can be persisted. */
  readonly onSnapshot?: (state: HostRestoreState) => void;
  readonly generation?: number;
  /**
   * Test seams for the robots: their timer and their pace.
   *
   * Every robot move goes through a pause, which is what makes a table readable —
   * and what would make a test of a whole round hundreds of macrotasks long. With
   * these a test pumps the pauses by hand and gets the same round every time.
   */
  readonly bot?: {
    readonly schedule?: (run: () => void, ms: number) => CancelPause;
    readonly pauseMs?: (kind: BotMoveKind, inSequence: boolean) => number;
  };
}

/**
 * The authoritative peer.
 *
 * Holds the only complete {@link GameState}, validates every action through the
 * pure engine, and broadcasts public state plus per-player private hands. It
 * never trusts a client-supplied player id: the id is bound to the connection at
 * join time and injected into every command.
 */
export class HostSession implements Session {
  readonly role = 'host' as const;
  readonly hostPeerId: string;
  readonly localPlayerId: string;
  readonly generation: number;

  private readonly seats: Seat[] = [];
  private readonly connections = new Map<TransportConnection, ConnectionRecord>();
  private readonly now: () => number;
  private readonly seedFactory: () => number;
  private readonly observer: SessionObserver;
  private readonly transport: Transport;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly onSnapshot: ((state: HostRestoreState) => void) | null;
  private readonly fixedIntervalMs: number | null;

  private phase: LobbySnapshot['phase'] = 'lobby';
  private maxPlayers: number;
  private tableLanguage: 'he' | 'en';
  private game: GameState | null = null;
  /** Highest state version this room has ever broadcast. */
  private versionFloor = 0;
  /** Rounds dealt so far, so the starting seat can rotate. */
  private round = 0;
  private playAgainVotes = new Set<string>();
  private abandonVotes = new Set<string>();
  private pausedBy: string | null = null;
  private watchdog: Watchdog | null = null;
  private destroyed = false;
  private signalling: SignallingState = 'up';
  private signallingLostAt: number | null = null;
  private selfDemoted = false;
  /** When the table started waiting for the seat on turn. */
  private waitingSince: number | null = null;
  /** The `waitingSince` a nudge-threshold snapshot has already gone out for. */
  private idleWaitBroadcastFor: number | null = null;
  /** When the watchdog last reported a gap, so the cycle after it is forgiving. */
  private lateTickAt: number | null = null;
  private handoffTo: string | null = null;
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Host clock at which each seat's hand became a single card.
   *
   * Kept here rather than in {@link GameState} because it is a clock reading, and
   * the engine is a pure function of its inputs — a timestamp inside it would make
   * a replayed command produce a different game. It is the host's, not the
   * caller's: a client that measured its own half second would be measuring from
   * whenever its snapshot happened to arrive.
   */
  private readonly lastCardSince = new Map<string, number>();

  /** Whether the table lets a robot play a seat nobody is answering for. */
  private standInEnabled: boolean;
  private readonly bots: BotRunner;
  /**
   * One random stream per robot seat, reseeded when a round is dealt.
   *
   * Separate from the game's own `RngState` on purpose: sharing it would make the
   * *presence* of a robot change the deal. Per seat rather than one shared stream,
   * so a robot's choices do not depend on how many decisions the others happened to
   * take first — which is what makes a robot-only round replay exactly.
   */
  private readonly botRng = new Map<string, RngState>();

  constructor(
    readonly roomCode: string,
    options: HostSessionOptions,
  ) {
    this.transport = options.transport;
    this.observer = options.observer;
    // Wrapped rather than captured: taking a reference to `Date.now` freezes
    // whichever implementation was installed when the session was built, which
    // makes the clock unswappable afterwards and is a trap for anything that
    // needs to reason about time passing.
    this.now = options.now ?? ((): number => Date.now());
    this.seedFactory = options.seedFactory ?? (() => randomInt(0x7fffffff));
    this.maxPlayers = Math.min(Math.max(options.maxPlayers, MIN_PLAYERS), MAX_PLAYERS);
    this.tableLanguage = options.tableLanguage;
    this.hostPeerId = options.transport.localId ?? '';
    this.onSnapshot = options.onSnapshot ?? null;
    this.fixedIntervalMs = options.heartbeatIntervalMs ?? null;
    this.generation = options.generation ?? 0;
    this.standInEnabled = options.restore?.standInEnabled ?? options.standInEnabled ?? true;

    const restore = options.restore;
    if (restore) {
      /*
       * The host's own player id has to come back with the room. It is otherwise
       * freshly minted, and the game state refers to the *old* one — so every
       * move the returning host made would be refused as coming from an unknown
       * player, and its own hand would render empty.
       */
      this.localPlayerId = restore.hostPlayerId;
      this.phase = restore.phase;
      this.maxPlayers = restore.maxPlayers;
      this.tableLanguage = restore.tableLanguage;
      this.game = restore.game;
      // A restored table starts everyone's half second again. The host that took
      // the reading is gone, and a stale one would either expose a player who has
      // been on one card all along or protect one for ever.
      this.trackLastCard();
      // Restoring the floor is what stops the returning host from broadcasting
      // versions every client will discard as stale.
      this.versionFloor = restore.versionFloor;
      this.round = restore.round;
      for (const seat of restore.seats) {
        // A robot has nothing to reconnect: it is here because the room is here.
        const bot = seat.bot === true;
        const present = seat.isHost || bot;
        this.seats.push({
          playerId: seat.playerId,
          name: seat.name,
          seat: seat.seat,
          isHost: seat.isHost,
          resumeToken: seat.resumeToken,
          peerId: null,
          lastSeenAt: this.now(),
          // Everyone else is away until they come back, including nobody's fault.
          health: present ? 'connected' : 'disconnected',
          absentSince: present ? null : this.now(),
          left: seat.left === true,
          lastResumeAttemptAt: null,
          standInDeclined: null,
          standInSince: null,
          robotPlayedThisRound: bot,
          bot,
          /*
           * A stand-in is deliberately not restored. This host has just lost every
           * connection it had, so it knows nothing about who is still there; the
           * ordinary thresholds work that out again from scratch. Carrying a stale
           * `'idle'` across a restart would be a claim about a device the new host
           * has never spoken to.
           */
          standIn: null,
          lastIntentAt: null,
          skippedWhileAway: false,
          saidGoodbye: false,
          lastRequestId: seat.lastRequestId ?? null,
          lastRequestVersion: seat.lastRequestVersion ?? null,
          probes: new ProbeTracker(),
        });
      }
      record('hostRestart', 'room restored', { seats: this.seats.length, phase: this.phase });
    } else {
      this.localPlayerId = createPlayerId();
      const hostName = uniquifyDisplayName(sanitizeDisplayName(options.hostDisplayName) || 'Host', []);
      this.seats.push({
        playerId: this.localPlayerId,
        name: hostName,
        seat: 0,
        isHost: true,
        resumeToken: createResumeToken(),
        peerId: this.hostPeerId,
        lastSeenAt: this.now(),
        health: 'connected',
        absentSince: null,
        left: false,
        lastResumeAttemptAt: null,
        standInDeclined: null,
        standInSince: null,
        robotPlayedThisRound: false,
        bot: false,
        standIn: null,
        lastIntentAt: null,
        skippedWhileAway: false,
        saidGoodbye: false,
        lastRequestId: null,
        lastRequestVersion: null,
        probes: new ProbeTracker(),
      });
    }

    this.bots = new BotRunner({
      view: (playerId) => {
        const seat = this.seatFor(playerId);
        if (!this.game || this.phase !== 'inGame' || !seat || seat.left) {
          return null;
        }
        // The same two projections a remote client is sent, and nothing else.
        return botViewFor(this.game, playerId, (id) => this.seatCanAnswer(id));
      },
      controlled: () =>
        this.robotSeats().map((seat) => ({ playerId: seat.playerId, standIn: seat.standIn !== null })),
      blocked: () =>
        this.destroyed || this.pausedBy !== null || this.phase !== 'inGame' || this.game === null,
      submit: (playerId, move) => this.submitBotMove(playerId, move),
      random: (playerId) => this.botRandom(playerId),
      ...(options.bot?.schedule ? { schedule: options.bot.schedule } : {}),
      ...(options.bot?.pauseMs ? { pauseMs: options.bot.pauseMs } : {}),
    });

    this.unsubscribes.push(
      this.transport.onIncoming((connection) => {
        this.registerConnection(connection);
      }),
      this.transport.onError((error) => {
        log.warn('transport error', error.code, error.message);
        record('transportError', error.code, { detail: error.message });
        this.observer({ type: 'error', error: sessionError(error.code, error.message) });
      }),
      this.transport.onSignallingChange((state) => {
        this.handleSignalling(state);
      }),
      onWake(() => {
        this.handleWake();
      }),
      onSleep((reason) => {
        if (reason === 'pagehide') {
          /*
           * The last reliable chance to speak. Saying "restarting" here turns an
           * ambiguous silence into a fact the clients can act on, and it is the
           * only such hook that fires on iOS, where `beforeunload` is ignored.
           */
          this.announceRestarting();
        }
      }),
    );

    this.observer({ type: 'phase', phase: 'connected' });
    this.observer({
      type: 'identity',
      playerId: this.localPlayerId,
      resumeToken: this.hostSeat()?.resumeToken ?? createResumeToken(),
      displayName: this.hostSeat()?.name ?? 'Host',
    });
    this.emitLobby();
    if (this.game) {
      this.broadcastGameState();
    }
    this.startWatchdog();
    this.persist();
    this.bots.schedule();
  }

  // ---------------------------------------------------------------- messaging

  private get messageContext(): MessageContext {
    return { roomId: this.roomCode, senderPeerId: this.hostPeerId, now: this.now };
  }

  private send<TType extends HostMessage['type']>(
    connection: TransportConnection,
    type: TType,
    payload: Extract<HostMessage, { type: TType }>['payload'],
  ): void {
    // `payload` is precisely typed by this signature; the inner generic
    // cannot re-derive it from a forwarded type parameter.
    connection.send(hostMessage(this.messageContext, type, payload as never));
  }

  private broadcast<TType extends HostMessage['type']>(
    type: TType,
    payload: Extract<HostMessage, { type: TType }>['payload'],
  ): void {
    for (const record_ of this.connections.values()) {
      if (record_.playerId && record_.connection.open) {
        this.send(record_.connection, type, payload as never);
      }
    }
  }

  private connectionForPlayer(playerId: string): ConnectionRecord | null {
    for (const record_ of this.connections.values()) {
      if (record_.playerId === playerId) {
        return record_;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- lobby

  private seatFor(playerId: string): Seat | undefined {
    return this.seats.find((seat) => seat.playerId === playerId);
  }

  private hostSeat(): Seat | undefined {
    return this.seats.find((seat) => seat.isHost);
  }

  /** Who the table is waiting for, and why — so no screen has to work it out. */
  private waiting(): { playerId: string | null; reason: LobbySnapshot['waitingReason'] } {
    if (this.pausedBy !== null) {
      return { playerId: this.pausedBy, reason: 'paused' };
    }
    if (!this.game || this.phase !== 'inGame') {
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
       * owner is. Nothing is being waited for: the table is moving, and telling
       * every screen it is holding a seat would contradict what they can see.
       */
      reason: seat && seat.health !== 'connected' && !this.robotControls(seat) ? 'absent' : 'turn',
    };
  }

  private lobbySnapshot(): LobbySnapshot {
    const players: LobbyPlayer[] = this.seats
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((seat) => ({
        id: seat.playerId,
        name: seat.name,
        isHost: seat.isHost,
        health: seat.health,
        seat: seat.seat,
        ...(seat.absentSince !== null ? { absentSince: seat.absentSince } : {}),
        ...(seat.left ? { left: true } : {}),
        ...(seat.bot ? { bot: true } : {}),
        ...(seat.standIn !== null ? { standIn: true } : {}),
        ...(seat.robotPlayedThisRound && !seat.bot ? { robotPlayed: true } : {}),
      }));
    const waiting = this.waiting();
    return {
      roomCode: this.roomCode,
      hostPeerId: this.hostPeerId,
      hostPlayerId: this.localPlayerId,
      maxPlayers: this.maxPlayers,
      phase: this.phase,
      players,
      tableLanguage: this.tableLanguage,
      sentAt: this.now(),
      seatGraceMs: SEAT_GRACE_MS,
      pausedBy: this.pausedBy,
      waitingFor: waiting.playerId,
      waitingReason: waiting.reason,
      waitingSince: this.waitingSince,
      abandonVotes: [...this.abandonVotes],
      generation: this.generation,
      standInEnabled: this.standInEnabled,
    };
  }

  private emitLobby(): void {
    const lobby = this.lobbySnapshot();
    this.observer({ type: 'lobby', lobby });
    this.broadcast('lobbyState', { lobby });
  }

  setMaxPlayers(value: number): void {
    if (this.phase !== 'lobby') {
      return;
    }
    const clamped = Math.min(Math.max(Math.round(value), MIN_PLAYERS), MAX_PLAYERS);
    if (clamped < this.seats.length) {
      return;
    }
    this.maxPlayers = clamped;
    this.emitLobby();
    this.persist();
  }

  setTableLanguage(language: 'he' | 'en'): void {
    this.tableLanguage = language;
    this.emitLobby();
    this.persist();
  }

  /** Removes a player before the game starts. */
  removePlayer(playerId: string): void {
    if (this.phase !== 'lobby' || playerId === this.localPlayerId) {
      return;
    }
    const found = this.connectionForPlayer(playerId);
    if (found) {
      this.send(found.connection, 'kicked', { reason: 'removedByHost' });
      found.playerId = null;
      // Give the message a chance to flush before tearing the channel down.
      queueMicrotask(() => found.connection.close());
    }
    const index = this.seats.findIndex((seat) => seat.playerId === playerId);
    if (index >= 0) {
      this.seats.splice(index, 1);
      this.resequenceSeats();
      this.botRng.delete(playerId);
    }
    this.emitLobby();
    this.persist();
    this.bots.schedule();
  }

  private resequenceSeats(): void {
    this.seats
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .forEach((seat, index) => {
        seat.seat = index;
      });
  }

  get connectedPlayerCount(): number {
    return this.seats.filter((seat) => seat.health !== 'disconnected').length;
  }

  // ------------------------------------------------------------- connections

  private registerConnection(connection: TransportConnection): void {
    if (this.destroyed) {
      connection.close();
      return;
    }
    log.debug('incoming connection', connection.remoteId);

    const entry: ConnectionRecord = {
      connection,
      playerId: null,
      dedup: new MessageDeduplicator(),
      protocolVersion: PROTOCOL_VERSION,
      unsubscribe: () => {},
    };

    // Only one live channel per remote peer id.
    for (const [existingConnection, existing] of this.connections) {
      if (existingConnection.remoteId === connection.remoteId) {
        log.warn('duplicate connection from', connection.remoteId);
        /*
         * Only tell a *seated* channel it was replaced. An unseated one is almost
         * always the client's own racing attempt, and answering that with a kick
         * used to end their session outright — the client treats a kick as final.
         */
        if (existing.playerId !== null) {
          this.send(existingConnection, 'kicked', { reason: 'duplicateConnection' });
          existing.playerId = null;
        }
        existingConnection.close();
      }
    }

    const offData = connection.onData((payload) => {
      this.handleIncoming(entry, payload);
    });
    const offClose = connection.onClose(() => {
      this.handleConnectionClosed(entry);
    });
    const offError = connection.onError((error) => {
      log.warn('connection error', connection.remoteId, error.code);
    });
    entry.unsubscribe = () => {
      offData();
      offClose();
      offError();
    };

    this.connections.set(connection, entry);
  }

  private handleConnectionClosed(entry: ConnectionRecord): void {
    entry.unsubscribe();
    this.connections.delete(entry.connection);
    const playerId = entry.playerId;
    if (!playerId) {
      return;
    }
    const seat = this.seatFor(playerId);
    if (!seat) {
      return;
    }
    this.markAbsent(seat);
    this.emitLobby();
    this.persist();
  }

  /**
   * Records a seat as present.
   *
   * `heard` is the whole of the distinction. Something actually arrived from them —
   * a message, a pong — and the silence clock may be restarted. Inferring presence
   * from the *absence* of contrary evidence must never touch that clock: doing so
   * fabricates proof of recent contact, and a peer that had been gone the whole
   * time is then forgiven every occasion the host's own tab slept.
   */
  private markPresent(seat: Seat, heard: boolean): void {
    if (heard) {
      seat.lastSeenAt = this.now();
    }
    if (seat.health === 'connected') {
      return;
    }
    seat.health = 'connected';
    seat.absentSince = null;
    seat.skippedWhileAway = false;
    // A refusal belongs to the absence it was made about, and that absence is over.
    seat.standInDeclined = null;
    // They are back, so the robot that was holding the fort stands down. The
    // stand-in exists for an empty chair, not for a slow one.
    this.endStandIn(seat);
    record('seatReturned', seat.name, { seat: seat.seat });
  }

  private markAbsent(seat: Seat): void {
    seat.peerId = null;
    if (seat.health !== 'disconnected') {
      seat.health = 'disconnected';
      seat.absentSince = this.now();
      record('seatAbsent', seat.name, { seat: seat.seat, phase: this.phase });
    }
  }

  private rejectJoin(connection: TransportConnection, reason: JoinRejectionReason): void {
    this.send(connection, 'joinRejected', { reason });
    queueMicrotask(() => connection.close());
  }

  private handleIncoming(entry: ConnectionRecord, payload: unknown): void {
    const parsed = parseClientMessage(payload);
    if (!parsed.ok) {
      log.warn('rejected message', parsed.error);
      if (parsed.error === 'protocolMismatch') {
        this.rejectJoin(entry.connection, 'protocolMismatch');
      }
      return;
    }
    const message = parsed.message;
    if (message.roomId !== this.roomCode) {
      log.warn('message for another room', message.roomId);
      return;
    }
    if (!entry.dedup.accept(message.id)) {
      log.debug('duplicate message dropped', message.id);
      return;
    }
    // Remembered so anything we send back can be phrased in a vocabulary this peer
    // actually has.
    entry.protocolVersion = message.protocolVersion;

    switch (message.type) {
      case 'joinRequest':
        this.handleJoinRequest(entry, message.payload.displayName);
        return;
      case 'resumeRequest':
        this.handleResumeRequest(entry, message.payload.playerId, message.payload.resumeToken);
        return;
      case 'ping':
        this.touch(entry);
        this.send(entry.connection, 'pong', { nonce: message.payload.nonce });
        return;
      case 'pong':
        this.touch(entry);
        if (entry.playerId) {
          this.seatFor(entry.playerId)?.probes.answered(message.payload.nonce, this.now());
        }
        return;
      case 'action':
        this.touch(entry);
        this.stampIntent(entry.playerId);
        this.handleAction(entry, message.payload);
        return;
      case 'playAgainVote':
        this.touch(entry);
        this.stampIntent(entry.playerId);
        this.handlePlayAgainVote(entry, message.payload.agree);
        return;
      case 'pauseRequest':
        this.touch(entry);
        this.stampIntent(entry.playerId);
        this.setPaused(message.payload.paused ? (entry.playerId ?? null) : null);
        return;
      case 'abandonVote':
        this.touch(entry);
        this.stampIntent(entry.playerId);
        this.handleAbandonVote(entry, message.payload.agree);
        return;
      case 'nudge':
        this.touch(entry);
        this.stampIntent(entry.playerId);
        this.handleNudge(entry, message.payload.targetPlayerId);
        return;
      case 'handoffAccepted':
        this.completeHandoff(entry, message.payload.generation);
        return;
      case 'leave':
        this.handleLeave(entry);
        return;
    }
  }

  private touch(entry: ConnectionRecord): void {
    if (!entry.playerId) {
      return;
    }
    const seat = this.seatFor(entry.playerId);
    if (!seat) {
      return;
    }
    const wasAway = seat.health !== 'connected';
    // Heard from: this is called because a message arrived.
    this.markPresent(seat, true);
    if (wasAway) {
      this.emitLobby();
      this.persist();
      this.bots.schedule();
    }
  }

  /**
   * Records that somebody actually asked for something.
   *
   * The distinction from {@link touch} is the whole of the idle stand-in: a
   * heartbeat says a device is powered on, an intent says a person is holding it.
   * A robot that stepped in for a silent seat stands down here, at once — before
   * whatever the player asked for is even applied, so their own move is the first
   * thing that happens when they come back.
   */
  private stampIntent(playerId: string | null): void {
    if (playerId === null) {
      return;
    }
    const seat = this.seatFor(playerId);
    if (!seat) {
      return;
    }
    seat.lastIntentAt = this.now();
    // A refusal belongs to the silence it was made about, and this ends that silence.
    seat.standInDeclined = null;
    if (seat.standIn !== null) {
      this.endStandIn(seat);
      this.emitLobby();
      this.persist();
      this.bots.schedule();
    }
  }

  private handleJoinRequest(entry: ConnectionRecord, requestedName: string): void {
    if (entry.playerId) {
      /*
       * Answer again rather than staying silent. A lost `joinAccepted` used to be
       * unrecoverable: the client retried, this returned early, and the join timed
       * out — with no credential stored either, because the credential arrives in
       * the message that went missing.
       */
      const seat = this.seatFor(entry.playerId);
      if (seat) {
        this.sendJoinAccepted(entry, seat);
      }
      return;
    }
    if (this.phase !== 'lobby') {
      this.rejectJoin(entry.connection, 'gameInProgress');
      return;
    }
    if (this.seats.length >= this.maxPlayers) {
      this.rejectJoin(entry.connection, 'roomFull');
      return;
    }
    const cleaned = sanitizeDisplayName(requestedName);
    if (cleaned.length === 0) {
      this.rejectJoin(entry.connection, 'invalidName');
      return;
    }

    const name = uniquifyDisplayName(
      cleaned,
      this.seats.map((seat) => seat.name),
    );
    const seat: Seat = {
      playerId: createPlayerId(),
      name,
      seat: this.seats.length,
      isHost: false,
      resumeToken: createResumeToken(),
      peerId: entry.connection.remoteId,
      lastSeenAt: this.now(),
      health: 'connected',
      absentSince: null,
      left: false,
      lastResumeAttemptAt: null,
      standInDeclined: null,
      standInSince: null,
      robotPlayedThisRound: false,
      bot: false,
      standIn: null,
      lastIntentAt: this.now(),
      skippedWhileAway: false,
      saidGoodbye: false,
      lastRequestId: null,
      lastRequestVersion: null,
      probes: new ProbeTracker(),
    };
    this.seats.push(seat);
    entry.playerId = seat.playerId;

    this.sendJoinAccepted(entry, seat);
    this.emitLobby();
    this.persist();
    log.debug('seated player', seat.name, seat.playerId);
  }

  private sendJoinAccepted(entry: ConnectionRecord, seat: Seat): void {
    this.send(entry.connection, 'joinAccepted', {
      playerId: seat.playerId,
      resumeToken: seat.resumeToken,
      displayName: seat.name,
      lobby: this.lobbySnapshot(),
    });
  }

  private handleResumeRequest(entry: ConnectionRecord, playerId: string, resumeToken: string): void {
    const seat = this.seatFor(playerId);
    // A robot's seat is not a seat anybody can come back to, and nor is the host's.
    if (!seat || seat.isHost || seat.bot) {
      this.rejectJoin(entry.connection, 'unknownSeat');
      return;
    }
    if (seat.left) {
      /*
       * The seat was retired from this round. Seating them anyway would put a
       * player at a table where every move they make is refused as coming from
       * somebody who has left — a dead end with no explanation. `unknownSeat` makes
       * the client drop the credential, so the offer they get is a fresh join.
       */
      this.rejectJoin(entry.connection, 'unknownSeat');
      return;
    }
    // Constant-time comparison is unnecessary here: the token is a local
    // reconnection secret, not an authentication credential for a shared server.
    if (seat.resumeToken !== resumeToken) {
      this.rejectJoin(entry.connection, 'invalidResumeToken');
      return;
    }
    // Recorded before anything else can fail: a rejoin *attempt* is what calls off
    // a pending skip, and it is worth knowing about even if this attempt dies.
    seat.lastResumeAttemptAt = this.now();

    const existing = this.connectionForPlayer(playerId);
    if (existing && existing !== entry) {
      existing.playerId = null;
      existing.connection.close();
    }

    entry.playerId = seat.playerId;
    seat.peerId = entry.connection.remoteId;
    seat.health = 'connected';
    seat.absentSince = null;
    seat.skippedWhileAway = false;
    seat.saidGoodbye = false;
    seat.standInDeclined = null;
    seat.lastSeenAt = this.now();
    // Coming back is the strongest intent there is, and it takes the seat back off
    // whichever robot was keeping it warm.
    seat.lastIntentAt = this.now();
    this.endStandIn(seat);
    seat.probes.reset();
    record('seatReturned', seat.name, { seat: seat.seat, resumed: true });

    this.sendJoinAccepted(entry, seat);
    this.emitLobby();

    if (this.game) {
      this.send(entry.connection, 'publicState', { state: toPublicGameState(this.game) });
      this.send(entry.connection, 'privateHand', {
        hand: toPrivateHandView(this.game, seat.playerId),
      });
    }
    this.persist();
    this.bots.schedule();
    log.debug('resumed player', seat.name);
  }

  private handleLeave(entry: ConnectionRecord): void {
    const playerId = entry.playerId;
    entry.playerId = null;
    if (playerId) {
      const index = this.seats.findIndex((seat) => seat.playerId === playerId);
      if (index >= 0 && this.phase === 'lobby') {
        this.seats.splice(index, 1);
        this.resequenceSeats();
      } else if (index >= 0) {
        const seat = this.seats[index] as Seat;
        // Saying goodbye is an intent like any other, so a robot that was standing
        // in for their silence stops — and `saidGoodbye` keeps another one from
        // starting, because playing the hand of somebody who said they were done is
        // not a favour.
        seat.lastIntentAt = this.now();
        this.endStandIn(seat);
        this.markAbsent(seat);
        /*
         * A goodbye is a strong hint, not a removal. It shortens the wait before
         * their turn is passed, because there is nothing left to wait for — but
         * taking the seat out of the round here would burn their credential and,
         * at a two-player table, end the round the instant somebody mis-taps.
         * The table can still remove them, or agree to stop, and either way it is
         * a decision rather than a side effect.
         */
        seat.saidGoodbye = true;
      }
      this.playAgainVotes.delete(playerId);
      this.abandonVotes.delete(playerId);
    }
    entry.connection.close();
    this.emitLobby();
    this.persist();
    this.bots.schedule();
  }

  // -------------------------------------------------------------------- game

  canStartGame(): boolean {
    return this.phase === 'lobby' && this.seats.length >= MIN_PLAYERS;
  }

  startGame(): void {
    if (!this.canStartGame()) {
      return;
    }
    const enginePlayers: EnginePlayer[] = this.seats
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((seat) => ({ id: seat.playerId, name: seat.name }));

    const result = createGame(enginePlayers, this.seedFactory(), this.versionFloor + 1, this.round);
    if (!result.ok) {
      this.observer({ type: 'error', error: sessionError('unknown', result.rejection.code) });
      return;
    }
    this.game = result.state;
    this.trackLastCard();
    this.versionFloor = result.state.version;
    this.round += 1;
    this.phase = 'inGame';
    this.playAgainVotes.clear();
    this.abandonVotes.clear();
    this.pausedBy = null;
    this.waitingSince = this.now();
    for (const seat of this.seats) {
      seat.left = false;
      seat.skippedWhileAway = false;
      // A mis-tapped "leave" in one round must not cost this player their grace for
      // the rest of the evening.
      seat.saidGoodbye = false;
      // Every seat starts the round its own. A stand-in from the last one would
      // hand a robot a hand nobody had asked it to play.
      seat.standIn = null;
      seat.standInSince = null;
      seat.standInDeclined = null;
      // A fresh round is nobody's to be judged by the last one.
      seat.robotPlayedThisRound = seat.bot;
    }
    this.reseedBots();
    this.emitLobby();
    this.broadcastGameState();
    this.emitEvents(result.events);
    this.persist();
    this.bots.schedule();
  }

  /**
   * Stamps the moment each seat came down to a single card, and forgets the ones
   * that did not.
   *
   * Called after every accepted command rather than on an event, because a hand
   * reaches one card from four different directions — a card played, a Taki
   * sequence closing on the last one, a +3 or a catch settling on somebody else —
   * and the reading has to be of the hand itself, not of the move that produced
   * it. Forgetting matters as much as stamping: a player who draws back up and
   * later returns to one card gets a fresh half second, exactly as they get a
   * fresh declaration.
   */
  private trackLastCard(): void {
    const game = this.game;
    if (!game) {
      this.lastCardSince.clear();
      return;
    }
    const now = this.now();
    for (const player of game.players) {
      if ((game.hands[player.id] ?? []).length === 1) {
        if (!this.lastCardSince.has(player.id)) {
          this.lastCardSince.set(player.id, now);
        }
      } else {
        this.lastCardSince.delete(player.id);
      }
    }
  }

  /** Whether `playerId` is still inside the head start their last card bought them. */
  private withinLastCardGrace(playerId: string): boolean {
    const since = this.lastCardSince.get(playerId);
    return since !== undefined && this.now() - since < LAST_CARD_GRACE_MS;
  }

  private broadcastGameState(): void {
    if (!this.game) {
      return;
    }
    const publicState = toPublicGameState(this.game);
    this.observer({ type: 'publicState', state: publicState });
    this.observer({ type: 'hand', cards: toPrivateHandView(this.game, this.localPlayerId).cards });

    for (const entry of this.connections.values()) {
      if (!entry.playerId || !entry.connection.open) {
        continue;
      }
      this.send(entry.connection, 'publicState', { state: publicState });
      this.send(entry.connection, 'privateHand', {
        hand: toPrivateHandView(this.game, entry.playerId),
      });
    }
  }

  private emitEvents(events: readonly GameEvent[]): void {
    if (events.length === 0) {
      return;
    }
    const version = this.game?.version ?? 0;
    this.observer({ type: 'events', events });
    // The *newest* 64, not the first: the client's own event floor means anything
    // dropped here is never re-sent, and the lines a player needs are the recent
    // ones.
    this.broadcast('gameEvents', { version, events: events.slice(-64) });
  }

  /** Applies a local (host player) action through the same authoritative path. */
  submitLocalAction(action: GameAction): void {
    // The host is a player too, and their own tap is the intent that takes their
    // seat back from a robot that had stepped in for them.
    this.stampIntent(this.localPlayerId);
    this.applyAction(this.localPlayerId, action, null);
  }

  /**
   * Intents that belong to a turn, and may therefore be checked against one.
   *
   * Declaring last card, catching somebody who did not, and answering a +3 are
   * deliberately absent: they are legal at any moment, they race each other on
   * purpose, and gating them on a turn would hand every tie to whichever player
   * broke the rule.
   */
  private static readonly TURN_SCOPED: ReadonlySet<GameAction['type']> = new Set<GameAction['type']>([
    'playCard',
    'drawCard',
    'closeTaki',
  ]);

  private handleAction(
    entry: ConnectionRecord,
    payload: {
      readonly action: GameAction;
      readonly requestId?: string;
      readonly turnToken?: { readonly currentPlayerId: string | null; readonly turnSeq: number };
    },
  ): void {
    if (!entry.playerId) {
      return;
    }
    const seat = this.seatFor(entry.playerId);
    if (!seat) {
      return;
    }
    /*
     * A request id we have already applied is answered, not re-applied. This is
     * the whole reason the record lives on the seat: a client that lost our answer
     * re-sends after reconnecting, and applying a `catchLastCard` twice is eight
     * cards charged for one call.
     */
    if (payload.requestId !== undefined && seat.lastRequestId === payload.requestId) {
      this.send(entry.connection, 'actionAccepted', {
        requestId: payload.requestId,
        version: seat.lastRequestVersion ?? this.versionFloor,
      });
      if (this.game) {
        this.send(entry.connection, 'publicState', { state: toPublicGameState(this.game) });
        this.send(entry.connection, 'privateHand', {
          hand: toPrivateHandView(this.game, seat.playerId),
        });
      }
      return;
    }
    /*
     * A turn-scoped intent computed against a turn that has since moved on is
     * refused rather than applied. Replaying a stale one is the real danger: a
     * card that was legal three moves ago may be illegal now, or already played.
     * A breaker answering an open +3 is exempt even though it is a `playCard`,
     * because the whole point of that card is that it is played out of turn.
     */
    const token = payload.turnToken;
    const answeringBreaker =
      this.game?.plusThree !== null &&
      this.game?.plusThree !== undefined &&
      payload.action.type === 'playCard';
    if (
      token !== undefined &&
      !answeringBreaker &&
      HostSession.TURN_SCOPED.has(payload.action.type) &&
      this.game !== null &&
      token.turnSeq !== this.game.turnSeq
    ) {
      this.rejectAction(entry, 'notYourTurn', payload.requestId);
      return;
    }
    this.applyAction(entry.playerId, payload.action, entry, payload.requestId);
  }

  /**
   * The one authoritative path, for a remote player, the host, and a robot alike.
   *
   * `origin` changes nothing about what is legal — a robot is refused exactly what
   * a player would be refused. It changes only who is *told*: a robot's rejection
   * goes to the diagnostics log, because routing it to the observer would raise a
   * toast on the host's own screen for somebody else's move and release the lock on
   * whatever the host had in flight.
   *
   * Returns whether the command was accepted, which is what lets the driver drop a
   * duty the table will not take instead of asking again on a loop.
   */
  private applyAction(
    playerId: string,
    action: GameAction,
    entry: ConnectionRecord | null,
    requestId?: string,
    origin: 'player' | 'bot' = 'player',
  ): boolean {
    if (!this.game || this.phase !== 'inGame') {
      return false;
    }
    if (this.pausedBy !== null) {
      // A pause everybody can see is worth honouring, or it is decoration — and it
      // needs its own code, because telling a player the round is over when the
      // table is merely waiting is worse than saying nothing.
      this.rejectAction(entry, 'tablePaused', requestId, origin);
      return false;
    }
    /*
     * Two reasons a catch is refused before the engine ever sees it, both of them
     * host policy rather than engine rules: the engine knows nothing about
     * connections, and nothing about clocks.
     *
     * An absent player cannot shout, so they cannot be caught out for silence.
     * Without this, absence turns a social rule into free farming — four cards an
     * orbit off somebody whose phone is rebooting.
     *
     * And a player who has just come down to one card gets their half second to
     * declare it. Both answer `nothingToCatch`: from the caller's side there is
     * nothing to catch *yet*, and the code is one every client already knows.
     */
    if (action.type === 'catchLastCard') {
      const target = this.seatFor(action.targetId);
      // A seat a robot is playing *can* shout, so it is catchable like anybody
      // else. The exemption is for a chair nobody is sitting in.
      if (target && target.health !== 'connected' && !this.robotControls(target)) {
        this.rejectAction(entry, 'nothingToCatch', requestId, origin);
        return false;
      }
      if (this.withinLastCardGrace(action.targetId)) {
        this.rejectAction(entry, 'nothingToCatch', requestId, origin);
        return false;
      }
    }
    const command: GameCommand = buildCommand(playerId, action);

    const result = applyCommand(this.game, command);
    if (!result.ok) {
      log.debug('rejected action', playerId, action.type, result.rejection.code);
      this.rejectAction(entry, result.rejection.code, requestId, origin);
      return false;
    }

    this.game = result.state;
    this.trackLastCard();
    this.versionFloor = result.state.version;
    const seat = this.seatFor(playerId);
    if (seat && requestId !== undefined) {
      seat.lastRequestId = requestId;
      seat.lastRequestVersion = result.state.version;
    }
    this.waitingSince = this.now();
    // Send the final table *before* announcing the phase change, so nobody
    // renders the end-of-round screen against the previous snapshot.
    this.broadcastGameState();
    this.emitEvents(result.events);
    /*
     * Acknowledged *after* the new table, not before. Acking first opens a window in
     * which the client's lock is released while its turn counter is still one
     * behind, and a move made inside it is refused as out of turn although it is
     * legal.
     */
    if (entry && requestId !== undefined) {
      this.send(entry.connection, 'actionAccepted', { requestId, version: result.state.version });
    }
    if (!entry && requestId !== undefined) {
      this.observer({ type: 'actionAccepted', requestId, version: result.state.version });
    }
    this.afterCommit();
    return true;
  }

  /** Answers one player, never the table: a rejection is nobody else's business. */
  private rejectAction(
    entry: ConnectionRecord | null,
    code: RejectionCode,
    requestId?: string,
    origin: 'player' | 'bot' = 'player',
  ): void {
    if (origin === 'bot') {
      // Nobody to tell. A robot's refused move is a fact about this build, so it
      // goes where facts about this build go.
      record('suspicion', `robot move refused: ${code}`);
      return;
    }
    if (entry) {
      const spoken = entry.protocolVersion < 4 ? (CODES_ADDED_IN_V4[code] ?? code) : code;
      this.send(entry.connection, 'actionRejected', {
        code: spoken,
        ...(requestId !== undefined ? { requestId } : {}),
      });
      return;
    }
    this.observer({
      type: 'actionRejected',
      code,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  /** Ends the round, or clears the machinery, after any accepted command. */
  private afterCommit(): void {
    if (this.game && this.game.phase === 'finished') {
      this.phase = 'finished';
      this.playAgainVotes.clear();
      this.abandonVotes.clear();
      this.pausedBy = null;
      this.autoVotePlayAgain();
      this.emitLobby();
      this.emitPlayAgain();
    } else {
      this.emitLobby();
    }
    this.persist();
    this.bots.schedule();
  }

  /** Runs a host-only engine command (skip, or a departure). */
  private applyHostCommand(command: GameCommand): boolean {
    if (!this.game || this.phase !== 'inGame') {
      return false;
    }
    const result = applyCommand(this.game, command);
    if (!result.ok) {
      log.debug('host command rejected', command.type, result.rejection.code);
      return false;
    }
    this.game = result.state;
    this.trackLastCard();
    this.versionFloor = result.state.version;
    this.broadcastGameState();
    this.emitEvents(result.events);
    this.waitingSince = this.now();
    this.afterCommit();
    return true;
  }

  /** Passes an absent player's turn, on the host's own authority. */
  skipAbsentTurn(playerId: string): boolean {
    const seat = this.seatFor(playerId);
    if (!seat || seat.health === 'connected' || seat.left) {
      return false;
    }
    const applied = this.applyHostCommand({ type: 'skipTurn', playerId });
    if (applied) {
      // Only after the engine has agreed. Latching the flag first drops this seat's
      // future grace to nought for ever on a rejection, and writes a skip into the
      // diagnostics log that never happened.
      seat.skippedWhileAway = true;
      record('turnSkipped', seat.name, { seat: seat.seat });
    }
    return applied;
  }

  /** Takes an absent player out of the round, keeping their cards out of play. */
  removeFromRound(playerId: string): boolean {
    const seat = this.seatFor(playerId);
    if (!seat || seat.left) {
      return false;
    }
    const applied = this.applyHostCommand({ type: 'leaveGame', playerId });
    if (applied) {
      // Marked only once the engine has agreed, or the lobby would say a seat had
      // left while the engine kept dealing it turns.
      seat.left = true;
      // A seat that has left the round is not a seat to play: the engine refuses
      // every command from it, so a robot left pointing at it would ask for ever.
      this.endStandIn(seat);
      this.emitLobby();
      this.persist();
      this.bots.schedule();
    }
    return applied;
  }

  // -------------------------------------------------------------- pause, votes

  setPaused(by: string | null): void {
    if (this.pausedBy === by) {
      return;
    }
    this.pausedBy = by;
    record('note', by === null ? 'table resumed' : 'table paused');
    this.broadcast('paused', { pausedBy: by });
    this.observer({ type: 'paused', pausedBy: by });
    this.emitLobby();
    // A hold stops the robots with everybody else, and letting go starts them again.
    this.bots.schedule();
  }

  private handleAbandonVote(entry: ConnectionRecord, agree: boolean): void {
    if (!entry.playerId) {
      return;
    }
    this.setAbandonVote(entry.playerId, agree);
  }

  voteAbandon(agree: boolean): void {
    this.stampIntent(this.localPlayerId);
    this.setAbandonVote(this.localPlayerId, agree);
  }

  private setAbandonVote(playerId: string, agree: boolean): void {
    if (this.phase !== 'inGame') {
      return;
    }
    if (agree) {
      this.abandonVotes.add(playerId);
    } else {
      this.abandonVotes.delete(playerId);
    }
    /*
     * Only the people. Stopping a round is a decision, and a robot has no view
     * about it — while a seat a robot is *standing in for* is by definition one
     * nobody is answering for, which is very often the reason the vote was called.
     * Counting either of them would let a robot veto the one escape hatch the table
     * has.
     */
    const present = this.seats.filter(
      (seat) => seat.health === 'connected' && !seat.left && !this.robotControls(seat),
    );
    const everyone = present.length > 0 && present.every((seat) => this.abandonVotes.has(seat.playerId));
    this.emitLobby();
    if (!everyone || !this.game) {
      return;
    }
    /*
     * Ending a round by agreement is what a real table does when somebody has to
     * go, and having it is most of the reason automatic host failover is not
     * needed to keep an evening moving. Nobody is marked as having left: the round
     * ended, and the standings show exactly where everyone was.
     */
    this.abandonVotes.clear();
    this.applyHostCommand({ type: 'abandonRound', playerId });
  }

  private handleNudge(entry: ConnectionRecord, targetPlayerId: string): void {
    if (!entry.playerId) {
      return;
    }
    const target = this.connectionForPlayer(targetPlayerId);
    if (target?.connection.open) {
      this.send(target.connection, 'nudged', { fromPlayerId: entry.playerId });
    } else if (targetPlayerId === this.localPlayerId) {
      this.observer({ type: 'nudged', fromPlayerId: entry.playerId });
    }
  }

  nudge(targetPlayerId: string): void {
    this.stampIntent(this.localPlayerId);
    const target = this.connectionForPlayer(targetPlayerId);
    if (target?.connection.open) {
      this.send(target.connection, 'nudged', { fromPlayerId: this.localPlayerId });
    }
  }

  // -------------------------------------------------------------- play again

  private handlePlayAgainVote(entry: ConnectionRecord, agree: boolean): void {
    if (!entry.playerId || this.phase !== 'finished') {
      return;
    }
    if (agree) {
      this.playAgainVotes.add(entry.playerId);
    } else {
      this.playAgainVotes.delete(entry.playerId);
    }
    this.maybeStartNextRound();
  }

  votePlayAgain(agree: boolean): void {
    this.stampIntent(this.localPlayerId);
    if (this.phase !== 'finished') {
      return;
    }
    if (agree) {
      this.playAgainVotes.add(this.localPlayerId);
    } else {
      this.playAgainVotes.delete(this.localPlayerId);
    }
    this.maybeStartNextRound();
  }

  /**
   * How many people the next round is waiting on.
   *
   * People, not seats. A robot's agreement is recorded so it can never block a round,
   * but publishing it made the standings say "2 of 2 agreed" while nothing happened —
   * telling the one person still there that everybody was ready and then waiting for
   * them. What they need to know is that the table is waiting for *them*.
   */
  private requiredVotes(): number {
    return this.seats.filter((seat) => seat.health !== 'disconnected' && !this.robotControls(seat)).length;
  }

  /**
   * A robot always wants to play again.
   *
   * It has to: a robot is counted among the seats a new round needs the agreement
   * of, and a table with one would otherwise never get a second deal. The same goes
   * for a seat a robot is standing in for — that seat is not answering, which is
   * precisely why the robot is there.
   */
  private autoVotePlayAgain(): void {
    for (const seat of this.seats) {
      // Only seats whose agreement is counted. A stand-in for a seat that is *away*
      // is not in `requiredVotes`, and voting for it anyway put "2 of 1 ready" on the
      // standings screen.
      if (this.robotControls(seat) && seat.health !== 'disconnected') {
        this.playAgainVotes.add(seat.playerId);
      }
    }
  }

  private emitPlayAgain(): void {
    // Robot agreements are the host's bookkeeping, not a line on anybody's screen.
    const agreed = [...this.playAgainVotes].filter((playerId) => {
      const seat = this.seatFor(playerId);
      return seat !== undefined && !this.robotControls(seat);
    });
    const required = this.requiredVotes();
    this.observer({ type: 'playAgain', agreed, required });
    this.broadcast('playAgainState', { agreed, required });
  }

  private maybeStartNextRound(): void {
    this.emitPlayAgain();
    const connected = this.seats.filter((seat) => seat.health !== 'disconnected');
    if (connected.length < MIN_PLAYERS) {
      return;
    }
    const everyoneAgreed = connected.every((seat) => this.playAgainVotes.has(seat.playerId));
    if (!everyoneAgreed) {
      return;
    }
    /*
     * Only drop seats whose grace has actually run out. This used to splice every
     * disconnected seat the moment a round ended, destroying the resume token a
     * player needed ten seconds later — and then answering their rejoin with
     * `unknownSeat`, which is a dead end.
     */
    const cutoff = this.now() - SEAT_GRACE_MS;
    for (let index = this.seats.length - 1; index >= 0; index -= 1) {
      const seat = this.seats[index] as Seat;
      if (seat.health === 'disconnected' && seat.absentSince !== null && seat.absentSince < cutoff) {
        this.seats.splice(index, 1);
      }
    }
    this.resequenceSeats();
    if (this.seats.length < MIN_PLAYERS) {
      return;
    }
    this.playAgainVotes.clear();
    this.phase = 'lobby';
    this.game = null;
    this.trackLastCard();
    this.startGame();
  }

  // -------------------------------------------------------------- heartbeat

  private currentInterval(): number {
    if (this.fixedIntervalMs !== null) {
      return this.fixedIntervalMs;
    }
    return probeInterval(this.phase === 'inGame');
  }

  private startWatchdog(): void {
    this.watchdog = createWatchdog({
      intervalMs: () => this.currentInterval(),
      now: this.now,
      onTick: (tick) => {
        this.tickHeartbeat(tick.late, tick.intervalMs);
      },
    });
  }

  private handleWake(): void {
    if (this.destroyed) {
      return;
    }
    // Re-ask everybody before judging anybody: a host that has just woken knows
    // nothing about the last few minutes.
    this.probeAll();
    this.watchdog?.restart();
  }

  private handleSignalling(state: SignallingState): void {
    this.signalling = state;
    record('signalling', `host ${state}`);
    if (state === 'down') {
      this.signallingLostAt = this.now();
      return;
    }
    this.signallingLostAt = null;
    if (this.selfDemoted) {
      this.selfDemoted = false;
      this.emitLobby();
    }
  }

  private probeAll(): void {
    const nonce = randomHex(4);
    for (const seat of this.seats) {
      if (seat.isHost) {
        continue;
      }
      const entry = this.connectionForPlayer(seat.playerId);
      if (entry?.connection.open) {
        this.send(entry.connection, 'ping', { nonce });
        seat.probes.sent(nonce, this.now());
      }
    }
  }

  private tickHeartbeat(late: boolean, intervalMs: number): void {
    if (this.destroyed) {
      return;
    }
    const now = this.now();

    if (late) {
      /*
       * We were asleep. Nobody is convicted on that evidence, and everybody is
       * asked again — but the *last heard from* clock is deliberately not reset.
       *
       * Resetting it was the obvious thing and it was wrong: it fabricates
       * evidence of recent contact, so a peer that had genuinely been gone the
       * whole time was forgiven every occasion the host's own tab slept. What is
       * cleared is the probe accounting, because those questions were asked into a
       * gap and their silence proves nothing. The answer to the fresh ones does.
       */
      record('suspicion', 'host watchdog tick was late');
      for (const seat of this.seats) {
        seat.probes.reset();
      }
      this.lateTickAt = now;
      this.probeAll();
      return;
    }
    /*
     * Immediately after a gap, silence is still ambiguous: the fresh probes have
     * not had time to be answered. One cycle of grace, then the normal rules.
     */
    const forgiveSilence = this.lateTickAt !== null && now - this.lateTickAt < intervalMs * 2;

    let changed = false;
    const nonce = randomHex(4);

    for (const seat of this.seats) {
      if (seat.isHost) {
        // The host's own seat used to be hard-coded as connected, so a table could
        // never see that the *host* was the one in trouble.
        const next: ConnectionHealth =
          this.signalling === 'down' && this.signallingLostAt !== null ? 'unstable' : 'connected';
        if (next !== seat.health) {
          seat.health = next;
          changed = true;
        }
        continue;
      }
      if (seat.bot) {
        /*
         * There is nothing to probe and nobody to convict. A robot seat was being
         * marked absent by the very next tick — it has no connection — and the table
         * would then hold, skip and eventually vacate a seat that was playing
         * perfectly well.
         */
        if (seat.health !== 'connected' || seat.absentSince !== null) {
          seat.health = 'connected';
          seat.absentSince = null;
          changed = true;
        }
        continue;
      }
      const entry = this.connectionForPlayer(seat.playerId);
      if (!entry || !entry.connection.open) {
        if (seat.health !== 'disconnected') {
          this.markAbsent(seat);
          changed = true;
        }
        continue;
      }
      this.send(entry.connection, 'ping', { nonce });
      seat.probes.sent(nonce, now);
      const oldest = seat.probes.oldestAgeMs(now);
      const silence = now - seat.lastSeenAt;
      const dead =
        !forgiveSilence &&
        (silence > silentAfterMs(intervalMs) || (oldest !== null && oldest > CHANNEL_DEAD_MS));
      /*
       * A seat is only promoted on positive evidence: every probe we have asked has
       * been answered. Treating "nothing has convicted them yet" as health is how a
       * channel that is open and carrying nothing gets reported as fine — and since
       * the late-tick branch clears the probe record, that would happen on the first
       * cycle after every occasion the host's own tab slept, freezing the table on
       * somebody who had long gone.
       */
      const answering = seat.probes.unanswered === 0;
      const next: ConnectionHealth = dead
        ? 'disconnected'
        : seat.probes.unanswered >= UNSTABLE_AFTER_MISSES
          ? 'unstable'
          : answering
            ? 'connected'
            : seat.health;
      if (next !== seat.health) {
        if (next === 'disconnected') {
          this.markAbsent(seat);
        } else if (next === 'connected') {
          /*
           * The same bookkeeping as an inbound message, so a seat recovered by the
           * heartbeat is not left carrying flags that cost it its next grace — but
           * *not* heard from, so its silence clock is left alone.
           */
          this.markPresent(seat, false);
        } else {
          seat.health = next;
        }
        changed = true;
      }
    }

    if (
      this.signallingLostAt !== null &&
      now - this.signallingLostAt > HOST_SELF_DEMOTE_MS &&
      !this.selfDemoted
    ) {
      /*
       * A host whose broker socket is gone keeps serving everybody already here
       * but can accept nobody new. Saying so is the honest option, and it is also
       * what makes a later handover safe: the incumbent concedes before anyone
       * else considers stepping in.
       */
      this.selfDemoted = true;
      record('suspicion', 'host cannot re-register with signalling');
      this.observer({ type: 'error', error: sessionError('signalingUnavailable', 'host demoted') });
      changed = true;
    }

    this.sweepLobbyGrace(now);
    if (changed) {
      this.emitLobby();
      this.persist();
    } else if (this.idleWaitBecameNudgeable(now)) {
      this.emitLobby();
    }
    this.sweepStandIns(now);
    this.tickAbsence(now);
    this.tickRobotStall(now);
    // The safety net for the robots: every path that changes the table calls this
    // too, and this is the one that runs even when nothing changed at all.
    this.bots.schedule();
  }

  /**
   * Whether the table has now been waiting on a *present* player long enough that
   * the others should be offered the nudge.
   *
   * The nudge is decided from `sentAt - waitingSince`, and both of those are the
   * host's own readings — which is what makes it immune to clock skew, and also
   * what made it unreachable: the only snapshot carrying a new `waitingSince` is
   * the one built in the same tick that set it, so the difference every client ever
   * saw was zero. Nothing else re-broadcasts the lobby while a healthy seat simply
   * thinks. This emits exactly one extra snapshot per idle turn, at the moment the
   * threshold is crossed, rather than putting the lobby on a cadence for the whole
   * game.
   */
  private idleWaitBecameNudgeable(now: number): boolean {
    const since = this.waitingSince;
    if (this.phase !== 'inGame' || since === null || this.idleWaitBroadcastFor === since) {
      return false;
    }
    if (now - since < IDLE_TURN_NUDGE_MS) {
      return false;
    }
    // An absent seat is the seat-hold callout's business, not the nudge's; nudging
    // somebody whose connection is gone is noise aimed at a device nobody is
    // holding.
    if (this.waiting().reason !== 'turn') {
      return false;
    }
    // And a robot cannot be nudged into paying attention.
    const waitingOn = this.waiting().playerId;
    if (waitingOn !== null) {
      const seat = this.seatFor(waitingOn);
      if (seat && this.robotControls(seat)) {
        return false;
      }
    }
    this.idleWaitBroadcastFor = since;
    return true;
  }

  /** Frees a lobby seat once its short grace has run out. */
  private sweepLobbyGrace(now: number): void {
    if (this.phase !== 'lobby') {
      return;
    }
    for (let index = this.seats.length - 1; index >= 0; index -= 1) {
      const seat = this.seats[index] as Seat;
      if (
        !seat.isHost &&
        seat.health === 'disconnected' &&
        seat.absentSince !== null &&
        now - seat.absentSince > LOBBY_GRACE_MS
      ) {
        // The lobby had no grace at all: a seat was freed the instant its channel
        // dropped, which is exactly where a phone is most likely to sleep.
        this.seats.splice(index, 1);
        this.resequenceSeats();
        this.emitLobby();
      }
    }
  }

  /**
   * Keeps the table moving when the seat on turn is not there.
   *
   * The +3 window is handled first and without any grace, because it is the worst
   * stall in the game and the one a turn-based check cannot see: while a +3 is
   * open the seat on turn is the player who *played* it, and every other command
   * from every other seat is refused. If the seats being waited on are away, the
   * table is frozen and nothing about the current player says so.
   */
  private tickAbsence(now: number): void {
    if (!this.game || this.phase !== 'inGame' || this.pausedBy !== null) {
      return;
    }

    const pending = this.game.plusThree;
    if (pending) {
      for (const awaited of pending.awaiting) {
        const seat = this.seatFor(awaited);
        if (!seat) {
          continue;
        }
        if (this.robotControls(seat)) {
          /*
           * A robot answers a +3 itself, and answering is better for the seat than
           * declining — so it is given a moment to. The deadline stays, because this
           * branch is the only thing that unfreezes the worst stall in the game and
           * "a robot will handle it" is not a guarantee a stalled timer keeps.
           */
          const since = Math.max(this.waitingSince ?? 0, seat.standInSince ?? 0);
          if (since > 0 && now - since > BOT_STALL_MS) {
            record('suspicion', 'robot did not answer a +3; declining for it');
            this.applyHostCommand({ type: 'passBreak', playerId: awaited });
            return;
          }
          continue;
        }
        if (seat.health === 'disconnected') {
          // Declining for them produces exactly what a present player's decline
          // produces, and — deliberately — no event naming who held a breaker.
          this.applyHostCommand({ type: 'passBreak', playerId: awaited });
          return;
        }
        /*
         * And the case that froze a table indefinitely: a seat that is *here*,
         * answering every heartbeat, and tapping nothing. The turn-based silence
         * check cannot see it, because while a +3 is open the seat on turn is the
         * player who played it — so this window needs its own deadline. A robot takes
         * the seat if the table allows one (it will break the +3, which is what its
         * owner would want); otherwise the host declines for them, which is what
         * every other seat is already waiting for.
         */
        const silentSince = Math.max(this.waitingSince ?? 0, seat.lastIntentAt ?? 0);
        if (silentSince > 0 && now - silentSince >= STAND_IN_IDLE_MS) {
          if (this.standInEnabled && seat.standInDeclined !== 'idle') {
            this.beginStandIn(seat, 'idle');
          } else {
            record('suspicion', 'a +3 window went unanswered; declining for the seat');
            this.applyHostCommand({ type: 'passBreak', playerId: awaited });
          }
          return;
        }
      }
      return;
    }

    const onTurn = currentPlayer(this.game);
    if (!onTurn) {
      return;
    }
    const seat = this.seatFor(onTurn.id);
    if (!seat || seat.left) {
      return;
    }
    if (this.robotControls(seat)) {
      // A robot is playing this seat. Its own backstop is the stall watchdog; the
      // absence machinery has nothing to add and must not skip a seat that is
      // being played.
      return;
    }
    if (seat.health === 'connected') {
      this.maybeStandInForSilence(seat, now);
      return;
    }
    if (
      seat.lastResumeAttemptAt !== null &&
      now - seat.lastResumeAttemptAt < RESUME_ATTEMPT_SUPPRESSES_SKIP_MS
    ) {
      // They are visibly trying to come back. That is much stronger evidence than
      // silence is of the opposite, and it costs nothing to wait for.
      return;
    }
    const grace =
      seat.skippedWhileAway || seat.saidGoodbye
        ? 0
        : seat.health === 'disconnected'
          ? ABSENT_TURN_GRACE_CLOSED_MS
          : ABSENT_TURN_GRACE_UNSTABLE_MS;
    /*
     * Measured from the later of "it became their turn" and "they went away".
     * Keying it on the last accepted move alone was wrong in the commonest case of
     * all: a player who is on turn, thinks for longer than the grace and *then*
     * drops would be skipped on the very first tick that noticed, so the twelve and
     * thirty second windows were nought.
     */
    const waitingFrom = Math.max(this.waitingSince ?? 0, seat.absentSince ?? 0);
    if (waitingFrom > 0 && now - waitingFrom < grace) {
      return;
    }
    this.skipAbsentTurn(onTurn.id);
  }

  /**
   * Hands a long-absent seat to a robot, if the table has asked for that.
   *
   * Swept across every seat rather than checked when its turn comes round, which was
   * the first version and was wrong: a seat that has been skipped once is skipped
   * again the instant its turn arrives, so the only moment the check could fire was
   * the one moment it was always too early for. A seat is also more than its turn —
   * a +3 to answer, a last card to declare — and a robot that only woke up on turn
   * would sit through all of it.
   *
   * Deliberately layered *on top of* the free skip rather than replacing it: a blip
   * is still answered by the skip that costs its owner nothing, and only a real
   * absence — well past three orbits of skipping — brings a robot in.
   */
  private sweepStandIns(now: number): void {
    if (!this.standInEnabled || this.phase !== 'inGame' || this.pausedBy !== null) {
      return;
    }
    for (const seat of this.seats) {
      if (
        seat.bot ||
        seat.left ||
        seat.standIn !== null ||
        // The table already said no to a robot covering this absence.
        seat.standInDeclined === 'absent' ||
        // A goodbye is a decision. Playing the hand of somebody who said they were
        // done is not a favour, and their seat is still theirs to come back to.
        seat.saidGoodbye ||
        seat.health !== 'disconnected' ||
        seat.absentSince === null ||
        now - seat.absentSince < STAND_IN_ABSENT_MS
      ) {
        continue;
      }
      if (
        seat.lastResumeAttemptAt !== null &&
        now - seat.lastResumeAttemptAt < RESUME_ATTEMPT_SUPPRESSES_SKIP_MS
      ) {
        // Visibly on their way back. Taking the seat over now would hand them a
        // hand that had been played for them in the seconds before they arrived.
        continue;
      }
      this.beginStandIn(seat, 'absent');
    }
  }

  /**
   * The seat on turn is here, and is not answering.
   *
   * Both clocks have to be old: the table has been waiting this long *and* nothing
   * has been asked for from that seat in that time. A heartbeat is not an answer —
   * a phone in a pocket sends those perfectly — which is why this reads
   * `lastIntentAt` and never `lastSeenAt`.
   */
  private maybeStandInForSilence(seat: Seat, now: number): void {
    if (
      !this.standInEnabled ||
      seat.bot ||
      seat.left ||
      seat.standIn !== null ||
      seat.standInDeclined === 'idle'
    ) {
      return;
    }
    const silentSince = Math.max(this.waitingSince ?? 0, seat.lastIntentAt ?? 0);
    if (silentSince === 0 || now - silentSince < STAND_IN_IDLE_MS) {
      return;
    }
    this.beginStandIn(seat, 'idle');
  }

  /**
   * The backstop for a robot that did not move.
   *
   * Nothing else would ever rescue this. A robot cannot be absent, so no grace, no
   * hold and no vacate applies to it — and a suspended tab, a throttled timer or a
   * bug in the driver would leave the round stopped with nothing on any screen to
   * explain why. The seat is passed exactly as an absent player's is, and the fact
   * is recorded, because a table that needs this has found a bug.
   */
  private tickRobotStall(now: number): void {
    if (!this.game || this.phase !== 'inGame' || this.pausedBy !== null) {
      return;
    }
    if (this.game.plusThree !== null) {
      // The breaker window has its own deadline, above.
      return;
    }
    const onTurn = currentPlayer(this.game);
    if (!onTurn) {
      return;
    }
    const seat = this.seatFor(onTurn.id);
    if (!seat || !this.robotControls(seat)) {
      return;
    }
    const waitingFrom = Math.max(this.waitingSince ?? 0, seat.standInSince ?? 0);
    if (waitingFrom === 0 || now - waitingFrom < BOT_STALL_MS) {
      return;
    }
    record('suspicion', 'robot did not move; passing the seat', { seat: seat.seat });
    this.applyHostCommand({ type: 'skipTurn', playerId: onTurn.id });
  }

  // ------------------------------------------------------------------ robots

  /** Whether a robot is playing this seat, for any reason. */
  private robotControls(seat: Seat): boolean {
    return (seat.bot || seat.standIn !== null) && !seat.left;
  }

  /** Seats a robot is playing, in seat order. */
  private robotSeats(): Seat[] {
    return this.seats
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
    if (!seat) {
      return false;
    }
    return seat.health === 'connected' || this.robotControls(seat);
  }

  /** Advances one robot's own random stream. */
  private botRandom(playerId: string): number {
    const state = this.botRng.get(playerId) ?? createRng(seedFromString(`${this.roomCode}:${playerId}`));
    const next = nextFloat(state);
    this.botRng.set(playerId, next.state);
    return next.value;
  }

  /** Starts every robot's stream again, so a round is reproducible from its deal. */
  private reseedBots(): void {
    this.botRng.clear();
    for (const seat of this.seats) {
      this.botRng.set(
        seat.playerId,
        createRng(seedFromString(`${this.roomCode}:${String(this.round)}:${seat.playerId}`)),
      );
    }
  }

  /**
   * Seats a robot. Lobby only, and never mid-round.
   *
   * A round is dealt to the seats it starts with: adding a player of any kind to a
   * table in play would mean dealing a hand out of a pile that is already in use,
   * and the engine has no such transition.
   */
  addBot(): boolean {
    if (this.phase !== 'lobby' || this.seats.length >= this.maxPlayers || this.destroyed) {
      return false;
    }
    const name = robotName(
      this.tableLanguage,
      this.seats.map((seat) => seat.name),
    );
    this.seats.push({
      playerId: createPlayerId(),
      name,
      seat: this.seats.length,
      isHost: false,
      // Minted like anybody else's, and never used: there is nothing to come back.
      resumeToken: createResumeToken(),
      peerId: null,
      lastSeenAt: this.now(),
      health: 'connected',
      absentSince: null,
      left: false,
      lastResumeAttemptAt: null,
      standInDeclined: null,
      standInSince: null,
      robotPlayedThisRound: true,
      bot: true,
      standIn: null,
      lastIntentAt: null,
      skippedWhileAway: false,
      saidGoodbye: false,
      lastRequestId: null,
      lastRequestVersion: null,
      probes: new ProbeTracker(),
    });
    record('note', 'robot seated', { name, seats: this.seats.length });
    this.emitLobby();
    this.persist();
    return true;
  }

  /** Whether the table lets a robot cover a seat nobody is answering for. */
  setStandInEnabled(enabled: boolean): void {
    if (this.standInEnabled === enabled) {
      return;
    }
    this.standInEnabled = enabled;
    if (!enabled) {
      // Switching it off hands every seat straight back; leaving robots playing
      // after the table said no would make the setting a suggestion.
      for (const seat of this.seats) {
        this.endStandIn(seat);
      }
    }
    this.emitLobby();
    this.persist();
    this.bots.schedule();
  }

  /**
   * Puts a robot on somebody's seat now, on the host's say-so.
   *
   * Its own consent: an explicit choice by the person running the table does not
   * need the table-wide setting as well, and it is the answer to "we are not
   * waiting another thirty seconds for this".
   */
  standInNow(playerId: string): boolean {
    const seat = this.seatFor(playerId);
    if (!seat || seat.bot || seat.left || seat.standIn !== null || this.phase !== 'inGame') {
      return false;
    }
    if (seat.health === 'connected') {
      /*
       * A seat that is here and answering is not the host's to give away. The control
       * exists for somebody who has stopped responding, so it needs the table to have
       * actually been waiting on them — otherwise one mis-tap takes a playing
       * player's hand off them mid-turn.
       */
      /*
       * This seat's own clock. `waitingSince` is the table's and is reset by anybody's
       * move, so a seat that had been silent for ten minutes while the others played
       * around it could not be covered — which is exactly the seat this is for.
       */
      const silentSince = seat.lastIntentAt ?? this.waitingSince ?? 0;
      if (silentSince === 0 || this.now() - silentSince < IDLE_TURN_NUDGE_MS) {
        return false;
      }
    }
    this.beginStandIn(seat, seat.health === 'connected' ? 'idle' : 'absent');
    return true;
  }

  /**
   * Hands a seat back to its owner, whether or not they have said anything.
   *
   * And remembers that it was asked for. A stand-in that restarted on the next
   * heartbeat made the control a lie, and — because a covered seat is not offered
   * the absent-seat controls — left the table with no way to stop a robot at all.
   */
  stopStandIn(playerId: string): boolean {
    const seat = this.seatFor(playerId);
    if (!seat || seat.standIn === null) {
      return false;
    }
    // About the kind that was actually running, and nothing else.
    seat.standInDeclined = seat.standIn;
    this.endStandIn(seat);
    this.emitLobby();
    this.persist();
    this.bots.schedule();
    return true;
  }

  private beginStandIn(seat: Seat, why: 'absent' | 'idle'): void {
    if (seat.bot || seat.left || seat.standIn !== null) {
      return;
    }
    seat.standIn = why;
    /*
     * The table starts waiting for the *robot* now, and its patience has to start now
     * too: the stall watchdog would otherwise inherit however long the seat had
     * already been silent — by definition longer than the deadline — and pass the
     * turn on the very next tick, before the robot had a moment.
     *
     * Only for the seat actually on turn, though. `waitingSince` is the table's
     * clock, not this seat's: resetting it while covering somebody else pushed out
     * another seat's skip grace, another seat's silence threshold, the nudge, and the
     * countdown every client is shown.
     */
    seat.standInSince = this.now();
    seat.robotPlayedThisRound = true;
    if (this.game && currentPlayer(this.game)?.id === seat.playerId) {
      this.waitingSince = this.now();
    }
    record('note', `a robot is playing for ${seat.name}`, { why, seat: seat.seat });
    if (!this.botRng.has(seat.playerId)) {
      this.botRng.set(
        seat.playerId,
        createRng(seedFromString(`${this.roomCode}:${String(this.round)}:${seat.playerId}`)),
      );
    }
    this.emitLobby();
    this.persist();
    this.bots.schedule();
  }

  /** Ends a stand-in. The caller owns telling the table; several callers batch it. */
  private endStandIn(seat: Seat): boolean {
    if (seat.standIn === null) {
      return false;
    }
    seat.standIn = null;
    seat.standInSince = null;
    /*
     * And takes the robot's answer back with it. A stand-in agrees to play again on
     * the seat's behalf, because a table with one could never deal a second round
     * otherwise — but the moment its owner is back, that agreement is theirs to give.
     * Leaving it behind dealt people into rounds they were never asked about.
     */
    if (this.phase === 'finished' && this.playAgainVotes.delete(seat.playerId)) {
      this.emitPlayAgain();
    }
    record('note', `${seat.name} has their seat back`, { seat: seat.seat });
    return true;
  }

  /**
   * Records that the local player asked for something.
   *
   * The host is a player too, and every remote intent stamps its seat — so the
   * table's own controls have to as well, or a host being stood in for taps Pause
   * and watches a robot carry on playing their hand.
   */
  noteLocalIntent(): void {
    this.stampIntent(this.localPlayerId);
  }

  /**
   * A robot's move, through the one authoritative path every move goes through.
   *
   * A refused move is *not* retried and buys no privilege. The most a robot gets is
   * what any player in that position has: if its own idea of the turn was refused,
   * it pays a card from the pile, which ends the turn. Nothing here can free-skip —
   * that is the host's own backstop, on a timer, and it is a bug when it fires.
   */
  private submitBotMove(playerId: string, move: BotMove): boolean {
    const seat = this.seatFor(playerId);
    if (!seat || !this.robotControls(seat)) {
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

  // ---------------------------------------------------------------- snapshot

  /**
   * Test seam: forces one seat's hand to a given size.
   *
   * Some rules only engage at a specific hand size — "last card" being the obvious
   * one — and a test that cannot reach that state ends up asserting that the engine
   * refuses an illegal move, which it would with the feature deleted.
   *
   * The cards it takes off the hand go back under the draw pile rather than out of
   * existence. That is not tidiness: the first version deleted them, which broke the
   * one invariant every absence test checks by counting the deck, and it left the
   * version number where it was, so a client that had already seen that version was
   * entitled to ignore the whole broadcast — a seam that silently does nothing is
   * worse than no seam at all.
   */
  forceHandForTests(playerId: string, size: number): void {
    if (!this.game) {
      return;
    }
    const hand = this.game.hands[playerId] ?? [];
    if (size >= hand.length) {
      return;
    }
    const removed = hand.slice(size);
    this.mutateForTests({
      hands: { ...this.game.hands, [playerId]: hand.slice(0, size) },
      drawPile: [...this.game.drawPile, ...removed],
    });
  }

  /**
   * Test seam: opens a breaker window that is waiting on one seat.
   *
   * Reaching this state through real play needs a specific deal, and the state
   * itself is the one that freezes a whole table — so it is worth being able to
   * construct directly rather than hoping a seed produces it.
   */
  forcePlusThreeForTests(awaitedPlayerId: string): void {
    if (!this.game) {
      return;
    }
    this.mutateForTests({
      plusThree: { playerId: this.localPlayerId, awaiting: [awaitedPlayerId] },
    });
  }

  /**
   * The one place a seam is allowed to write authoritative state.
   *
   * Everything that reaches a client goes through the same two steps as a real
   * command — the version advances and the floor moves with it — so a forced
   * situation is indistinguishable from a played one, and no test can pass because
   * of a shortcut the game itself does not have.
   */
  private mutateForTests(patch: Partial<GameState>): void {
    if (!this.game) {
      return;
    }
    this.game = { ...this.game, ...patch, version: this.game.version + 1 };
    this.trackLastCard();
    this.versionFloor = this.game.version;
    this.broadcastGameState();
    // A forced situation is meant to be indistinguishable from a played one, and a
    // played one wakes the robots.
    this.bots.schedule();
  }

  /** The room in a form that can be written down and read back. */
  snapshot(): HostRestoreState {
    return {
      hostPlayerId: this.localPlayerId,
      phase: this.phase,
      maxPlayers: this.maxPlayers,
      tableLanguage: this.tableLanguage,
      versionFloor: this.versionFloor,
      round: this.round,
      seats: this.seats.map((seat) => ({
        playerId: seat.playerId,
        name: seat.name,
        seat: seat.seat,
        isHost: seat.isHost,
        resumeToken: seat.resumeToken,
        ...(seat.left ? { left: true } : {}),
        ...(seat.bot ? { bot: true } : {}),
        lastRequestId: seat.lastRequestId,
        lastRequestVersion: seat.lastRequestVersion,
      })),
      standInEnabled: this.standInEnabled,
      game: this.game,
    };
  }

  private persist(): void {
    this.onSnapshot?.(this.snapshot());
  }

  /** Tells everyone this device is about to reload, so nobody treats it as a goodbye. */
  announceRestarting(): void {
    if (this.destroyed) {
      return;
    }
    this.persist();
    this.broadcast('hostClosed', { reason: 'restarting' });
  }

  // ---------------------------------------------------------------- handover

  /**
   * The seat that would take the room over: the lowest-seated player who is here.
   *
   * A robot is never a candidate, and neither is a seat a robot is playing. There is
   * no device behind the first and nobody looking at the second, so the room would
   * be handed to something that cannot serve it — and the offer would expire while
   * the old host had already gone.
   */
  get successor(): { playerId: string; name: string } | null {
    const candidate = this.seats
      .filter(
        (seat) =>
          !seat.isHost && seat.health === 'connected' && !seat.left && !seat.bot && seat.standIn === null,
      )
      .sort((a, b) => a.seat - b.seat)[0];
    return candidate ? { playerId: candidate.playerId, name: candidate.name } : null;
  }

  /**
   * Offers the room to another player and waits for them to accept.
   *
   * Only ever from a living host on a channel both sides already trust, which is
   * what makes it safe without any of the verification machinery an automatic
   * takeover would need. The state travels once, here — not on every move.
   */
  offerHandoff(playerId: string): boolean {
    const entry = this.connectionForPlayer(playerId);
    if (!entry?.connection.open) {
      return false;
    }
    this.handoffTo = playerId;
    if (this.handoffTimer !== null) {
      clearTimeout(this.handoffTimer);
    }
    /*
     * An offer nobody takes up has to expire. Otherwise the room is left in a state
     * where a seat could claim it much later — after the host had carried on
     * playing for ten minutes — and step in on a state that is long stale.
     */
    this.handoffTimer = setTimeout(() => {
      this.handoffTimer = null;
      if (this.handoffTo === playerId) {
        record('handover', 'offer expired', { to: playerId });
        this.handoffTo = null;
      }
    }, HANDOFF_TIMEOUT_MS);
    record('handover', 'offered', { to: playerId, generation: this.generation + 1 });
    this.send(entry.connection, 'handoffOffer', {
      generation: this.generation + 1,
      snapshot: this.snapshot(),
    });
    return true;
  }

  private completeHandoff(entry: ConnectionRecord, generation: number): void {
    if (entry.playerId === null || entry.playerId !== this.handoffTo) {
      return;
    }
    record('handover', 'accepted', { by: entry.playerId, generation });
    for (const other of this.connections.values()) {
      // Not the successor: it is becoming the host, not looking for one. Telling it
      // to go and find the new host would have it chase its own peer id.
      if (other !== entry && other.playerId && other.connection.open) {
        // Only the generation travels: the id is derived from it, so there is
        // nothing to get wrong and nothing to look up.
        this.send(other.connection, 'hostClosed', { reason: 'handoff', generation });
      }
    }
    // Silent: the table has already been told where the room went, and following
    // that with the ordinary "the host left" would be a contradiction — and
    // `hostLeft` is terminal for a client, so it would strand everybody. Over the
    // in-memory transport `close()` is synchronous and hides this; over a real data
    // channel it is not, and the goodbye really is sent.
    this.destroy('leftVoluntarily', { silent: true });
  }

  // ---------------------------------------------------------------- teardown

  destroy(reason: SessionClosedReason = 'leftVoluntarily', options: { silent?: boolean } = {}): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    // First, before anything else can be torn down: a robot pause that fired after
    // this point would mutate state nobody owns any more and speak to closed
    // channels — including, during a handover, on behalf of a room that has moved.
    this.bots.destroy();
    this.watchdog?.stop();
    this.watchdog = null;
    if (this.handoffTimer !== null) {
      clearTimeout(this.handoffTimer);
      this.handoffTimer = null;
    }
    for (const entry of this.connections.values()) {
      if (entry.connection.open && options.silent !== true) {
        this.send(entry.connection, 'hostClosed', { reason: 'hostLeft' });
      }
      entry.unsubscribe();
      entry.connection.close();
    }
    this.connections.clear();
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes.length = 0;
    this.transport.destroy();
    this.observer({ type: 'phase', phase: 'disconnected' });
    this.observer({ type: 'closed', reason });
  }
}

/** Creates a host session once the transport has an assigned peer id. */
export async function createHostSession(options: HostSessionOptions): Promise<HostSession> {
  await options.transport.ready();
  return new HostSession(options.roomCode, options);
}

/** Deterministic seed helper used when a room should replay identically. */
export function seedForRoom(roomCode: string, round: number): number {
  return seedFromString(`${roomCode}:${round}`);
}
