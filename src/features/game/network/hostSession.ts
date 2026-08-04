import { record } from '../../../lib/diagnostics.ts';
import { createPlayerId, createResumeToken, randomHex, randomInt } from '../../../lib/id.ts';
import { onSleep, onWake } from '../../../lib/lifecycle.ts';
import { createLogger } from '../../../lib/logger.ts';
import { sanitizeDisplayName, uniquifyDisplayName } from '../../../lib/sanitize.ts';
import { applyCommand, createGame, currentPlayer } from '../engine/engine.ts';
import { seedFromString } from '../engine/prng.ts';
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
  CHANNEL_DEAD_MS,
  HOST_SELF_DEMOTE_MS,
  LOBBY_GRACE_MS,
  RESUME_ATTEMPT_SUPPRESSES_SKIP_MS,
  SEAT_GRACE_MS,
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
  /** Whether this seat has already been skipped once without returning. */
  skippedWhileAway: boolean;
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
  unsubscribe: () => void;
}

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
    readonly lastRequestId?: string | null;
    readonly lastRequestVersion?: number | null;
  }[];
  readonly game: GameState | null;
}

export interface HostSessionOptions {
  readonly transport: Transport;
  readonly roomCode: string;
  readonly hostDisplayName: string;
  readonly maxPlayers: number;
  readonly tableLanguage: 'he' | 'en';
  readonly observer: SessionObserver;
  readonly now?: () => number;
  readonly seedFactory?: () => number;
  readonly heartbeatIntervalMs?: number;
  /** Rebuilds a room this device was already hosting. */
  readonly restore?: HostRestoreState;
  /** Called whenever the room state changes, so it can be persisted. */
  readonly onSnapshot?: (state: HostRestoreState) => void;
  readonly generation?: number;
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
  private handoffTo: string | null = null;

  constructor(
    readonly roomCode: string,
    options: HostSessionOptions,
  ) {
    this.transport = options.transport;
    this.observer = options.observer;
    this.now = options.now ?? Date.now;
    this.seedFactory = options.seedFactory ?? (() => randomInt(0x7fffffff));
    this.maxPlayers = Math.min(Math.max(options.maxPlayers, MIN_PLAYERS), MAX_PLAYERS);
    this.tableLanguage = options.tableLanguage;
    this.hostPeerId = options.transport.localId ?? '';
    this.onSnapshot = options.onSnapshot ?? null;
    this.fixedIntervalMs = options.heartbeatIntervalMs ?? null;
    this.generation = options.generation ?? 0;

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
      // Restoring the floor is what stops the returning host from broadcasting
      // versions every client will discard as stale.
      this.versionFloor = restore.versionFloor;
      this.round = restore.round;
      for (const seat of restore.seats) {
        this.seats.push({
          playerId: seat.playerId,
          name: seat.name,
          seat: seat.seat,
          isHost: seat.isHost,
          resumeToken: seat.resumeToken,
          peerId: null,
          lastSeenAt: this.now(),
          // Everyone is away until they come back, including nobody's fault.
          health: seat.isHost ? 'connected' : 'disconnected',
          absentSince: seat.isHost ? null : this.now(),
          left: seat.left === true,
          lastResumeAttemptAt: null,
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
        skippedWhileAway: false,
        saidGoodbye: false,
        lastRequestId: null,
        lastRequestVersion: null,
        probes: new ProbeTracker(),
      });
    }

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
      reason: seat && seat.health !== 'connected' ? 'absent' : 'turn',
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
      abandonVotes: [...this.abandonVotes],
      generation: this.generation,
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
    }
    this.emitLobby();
    this.persist();
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

  /** Seats currently away, for the UI to explain and count down. */
  get absentSeats(): readonly { playerId: string; name: string; absentSince: number }[] {
    return this.seats
      .filter((seat) => seat.absentSince !== null && !seat.left)
      .map((seat) => ({ playerId: seat.playerId, name: seat.name, absentSince: seat.absentSince as number }));
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
        this.handleAction(entry, message.payload);
        return;
      case 'playAgainVote':
        this.touch(entry);
        this.handlePlayAgainVote(entry, message.payload.agree);
        return;
      case 'pauseRequest':
        this.touch(entry);
        this.setPaused(message.payload.paused ? (entry.playerId ?? null) : null);
        return;
      case 'abandonVote':
        this.touch(entry);
        this.handleAbandonVote(entry, message.payload.agree);
        return;
      case 'nudge':
        this.touch(entry);
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
    seat.lastSeenAt = this.now();
    if (seat.health !== 'connected') {
      seat.health = 'connected';
      seat.absentSince = null;
      seat.skippedWhileAway = false;
      record('seatReturned', seat.name, { seat: seat.seat });
      this.emitLobby();
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
    if (!seat || seat.isHost) {
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
    seat.lastSeenAt = this.now();
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
  }

  // -------------------------------------------------------------------- game

  canStartGame(): boolean {
    return this.phase === 'lobby' && this.seats.length >= MIN_PLAYERS;
  }

  /** True while any seat is away, which the host should see before dealing. */
  get hasAbsentSeats(): boolean {
    return this.seats.some((seat) => seat.health !== 'connected');
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
    }
    this.emitLobby();
    this.broadcastGameState();
    this.emitEvents(result.events);
    this.persist();
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
    this.broadcast('gameEvents', { version, events: events.slice(0, 64) });
  }

  /** Applies a local (host player) action through the same authoritative path. */
  submitLocalAction(action: GameAction): void {
    this.applyAction(this.localPlayerId, action, null);
  }

  private handleAction(
    entry: ConnectionRecord,
    payload: { readonly action: GameAction; readonly requestId?: string; readonly turnToken?: unknown },
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
    this.applyAction(entry.playerId, payload.action, entry, payload.requestId);
  }

  private applyAction(
    playerId: string,
    action: GameAction,
    entry: ConnectionRecord | null,
    requestId?: string,
  ): void {
    if (!this.game || this.phase !== 'inGame') {
      return;
    }
    if (this.pausedBy !== null) {
      // A pause everybody can see is worth honouring, or it is decoration.
      this.rejectAction(entry, 'gameFinished', requestId);
      return;
    }
    /*
     * An absent player cannot shout, so they cannot be caught out for silence.
     * Without this, absence turns a social rule into free farming — four cards an
     * orbit off somebody whose phone is rebooting. Host policy rather than an
     * engine rule, because the engine knows nothing about connections.
     */
    if (action.type === 'catchLastCard') {
      const target = this.seatFor(action.targetId);
      if (target && target.health !== 'connected') {
        this.rejectAction(entry, 'nothingToCatch', requestId);
        return;
      }
    }
    const command: GameCommand = buildCommand(playerId, action);

    const result = applyCommand(this.game, command);
    if (!result.ok) {
      log.debug('rejected action', playerId, action.type, result.rejection.code);
      this.rejectAction(entry, result.rejection.code, requestId);
      return;
    }

    this.game = result.state;
    this.versionFloor = result.state.version;
    const seat = this.seatFor(playerId);
    if (seat && requestId !== undefined) {
      seat.lastRequestId = requestId;
      seat.lastRequestVersion = result.state.version;
    }
    if (entry && requestId !== undefined) {
      this.send(entry.connection, 'actionAccepted', { requestId, version: result.state.version });
    }
    if (!entry && requestId !== undefined) {
      this.observer({ type: 'actionAccepted', requestId, version: result.state.version });
    }
    this.waitingSince = this.now();
    // Send the final table *before* announcing the phase change, so nobody
    // renders the end-of-round screen against the previous snapshot.
    this.broadcastGameState();
    this.emitEvents(result.events);
    this.afterCommit();
  }

  /** Answers one player, never the table: a rejection is nobody else's business. */
  private rejectAction(entry: ConnectionRecord | null, code: RejectionCode, requestId?: string): void {
    if (entry) {
      this.send(entry.connection, 'actionRejected', {
        code,
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
      this.emitLobby();
      this.emitPlayAgain();
    } else {
      this.emitLobby();
    }
    this.persist();
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
    seat.skippedWhileAway = true;
    record('turnSkipped', seat.name, { seat: seat.seat });
    return this.applyHostCommand({ type: 'skipTurn', playerId });
  }

  /** Takes an absent player out of the round, keeping their cards out of play. */
  removeFromRound(playerId: string): boolean {
    const seat = this.seatFor(playerId);
    if (!seat || seat.left) {
      return false;
    }
    seat.left = true;
    const applied = this.applyHostCommand({ type: 'leaveGame', playerId });
    if (applied) {
      this.emitLobby();
      this.persist();
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
  }

  private handleAbandonVote(entry: ConnectionRecord, agree: boolean): void {
    if (!entry.playerId) {
      return;
    }
    this.setAbandonVote(entry.playerId, agree);
  }

  voteAbandon(agree: boolean): void {
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
    const present = this.seats.filter((seat) => seat.health === 'connected' && !seat.left);
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

  private requiredVotes(): number {
    return this.seats.filter((seat) => seat.health !== 'disconnected').length;
  }

  private emitPlayAgain(): void {
    const agreed = [...this.playAgainVotes];
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
      // We were asleep. Nobody is convicted on that evidence; everybody is asked.
      record('suspicion', 'host watchdog tick was late');
      for (const seat of this.seats) {
        seat.probes.reset();
        seat.lastSeenAt = now;
      }
      this.probeAll();
      return;
    }

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
      const next: ConnectionHealth =
        silence > silentAfterMs(intervalMs) || (oldest !== null && oldest > CHANNEL_DEAD_MS)
          ? 'disconnected'
          : seat.probes.unanswered >= UNSTABLE_AFTER_MISSES
            ? 'unstable'
            : 'connected';
      if (next !== seat.health) {
        if (next === 'disconnected') {
          this.markAbsent(seat);
        } else {
          seat.health = next;
          if (next === 'connected') {
            seat.absentSince = null;
          }
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
    }
    this.tickAbsence(now);
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
        if (seat && seat.health === 'disconnected') {
          // Declining for them produces exactly what a present player's decline
          // produces, and — deliberately — no event naming who held a breaker.
          this.applyHostCommand({ type: 'passBreak', playerId: awaited });
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
    if (!seat || seat.health === 'connected' || seat.left) {
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
    if (this.waitingSince !== null && now - this.waitingSince < grace) {
      return;
    }
    this.skipAbsentTurn(onTurn.id);
  }

  // ---------------------------------------------------------------- snapshot

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
        lastRequestId: seat.lastRequestId,
        lastRequestVersion: seat.lastRequestVersion,
      })),
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

  /** The seat that would take the room over: the lowest-seated player who is here. */
  get successor(): { playerId: string; name: string } | null {
    const candidate = this.seats
      .filter((seat) => !seat.isHost && seat.health === 'connected' && !seat.left)
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
    const successorPeerId = entry.connection.remoteId;
    record('handover', 'accepted', { by: entry.playerId, generation });
    for (const other of this.connections.values()) {
      if (other.playerId && other.connection.open) {
        this.send(other.connection, 'hostClosed', {
          reason: 'handoff',
          successorPeerId,
          generation,
        });
      }
    }
    this.destroy('leftVoluntarily');
  }

  // ---------------------------------------------------------------- teardown

  destroy(reason: SessionClosedReason = 'leftVoluntarily'): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.watchdog?.stop();
    this.watchdog = null;
    for (const entry of this.connections.values()) {
      if (entry.connection.open) {
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
