import { createPlayerId, createResumeToken, randomHex, randomInt } from '../../../lib/id.ts';
import { createLogger } from '../../../lib/logger.ts';
import { sanitizeDisplayName, uniquifyDisplayName } from '../../../lib/sanitize.ts';
import { applyCommand, createGame } from '../engine/engine.ts';
import { seedFromString } from '../engine/prng.ts';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type EnginePlayer,
  type GameCommand,
  type GameEvent,
  type GameState,
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
import {
  HEARTBEAT,
  sessionError,
  type Session,
  type SessionClosedReason,
  type SessionObserver,
} from './session.ts';
import type { Transport, TransportConnection } from './transport.ts';

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
}

interface ConnectionRecord {
  connection: TransportConnection;
  playerId: string | null;
  dedup: MessageDeduplicator;
  unsubscribe: () => void;
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

  private readonly seats: Seat[] = [];
  private readonly connections = new Map<TransportConnection, ConnectionRecord>();
  private readonly now: () => number;
  private readonly seedFactory: () => number;
  private readonly observer: SessionObserver;
  private readonly transport: Transport;
  private readonly unsubscribes: Array<() => void> = [];

  private phase: LobbySnapshot['phase'] = 'lobby';
  private maxPlayers: number;
  private tableLanguage: 'he' | 'en';
  private game: GameState | null = null;
  private playAgainVotes = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

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
    });

    this.unsubscribes.push(
      this.transport.onIncoming((connection) => {
        this.registerConnection(connection);
      }),
      this.transport.onError((error) => {
        log.warn('transport error', error.code, error.message);
        this.observer({ type: 'error', error: sessionError(error.code, error.message) });
      }),
    );

    this.observer({ type: 'phase', phase: 'connected' });
    this.observer({
      type: 'identity',
      playerId: this.localPlayerId,
      resumeToken: this.seats[0]!.resumeToken,
      displayName: hostName,
    });
    this.emitLobby();
    this.startHeartbeat(options.heartbeatIntervalMs ?? HEARTBEAT.intervalMs);
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
    for (const record of this.connections.values()) {
      if (record.playerId && record.connection.open) {
        this.send(record.connection, type, payload as never);
      }
    }
  }

  private connectionForPlayer(playerId: string): ConnectionRecord | null {
    for (const record of this.connections.values()) {
      if (record.playerId === playerId) {
        return record;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- lobby

  private seatFor(playerId: string): Seat | undefined {
    return this.seats.find((seat) => seat.playerId === playerId);
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
      }));
    return {
      roomCode: this.roomCode,
      hostPeerId: this.hostPeerId,
      hostPlayerId: this.localPlayerId,
      maxPlayers: this.maxPlayers,
      phase: this.phase,
      players,
      tableLanguage: this.tableLanguage,
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
  }

  setTableLanguage(language: 'he' | 'en'): void {
    this.tableLanguage = language;
    this.emitLobby();
  }

  /** Removes a player before the game starts. */
  removePlayer(playerId: string): void {
    if (this.phase !== 'lobby' || playerId === this.localPlayerId) {
      return;
    }
    const record = this.connectionForPlayer(playerId);
    if (record) {
      this.send(record.connection, 'kicked', { reason: 'removedByHost' });
      record.playerId = null;
      // Give the message a chance to flush before tearing the channel down.
      queueMicrotask(() => record.connection.close());
    }
    const index = this.seats.findIndex((seat) => seat.playerId === playerId);
    if (index >= 0) {
      this.seats.splice(index, 1);
      this.resequenceSeats();
    }
    this.emitLobby();
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

    const record: ConnectionRecord = {
      connection,
      playerId: null,
      dedup: new MessageDeduplicator(),
      unsubscribe: () => {},
    };

    // Only one live channel per remote peer id.
    for (const [existingConnection, existing] of this.connections) {
      if (existingConnection.remoteId === connection.remoteId) {
        log.warn('duplicate connection from', connection.remoteId);
        this.send(existingConnection, 'kicked', { reason: 'duplicateConnection' });
        existing.playerId = null;
        existingConnection.close();
      }
    }

    const offData = connection.onData((payload) => {
      this.handleIncoming(record, payload);
    });
    const offClose = connection.onClose(() => {
      this.handleConnectionClosed(record);
    });
    const offError = connection.onError((error) => {
      log.warn('connection error', connection.remoteId, error.code);
    });
    record.unsubscribe = () => {
      offData();
      offClose();
      offError();
    };

    this.connections.set(connection, record);
  }

  private handleConnectionClosed(record: ConnectionRecord): void {
    record.unsubscribe();
    this.connections.delete(record.connection);
    const playerId = record.playerId;
    if (!playerId) {
      return;
    }
    const seat = this.seatFor(playerId);
    if (!seat) {
      return;
    }
    if (this.phase === 'lobby') {
      const index = this.seats.indexOf(seat);
      this.seats.splice(index, 1);
      this.resequenceSeats();
    } else {
      // Keep the seat so the player can resume mid-game.
      seat.health = 'disconnected';
      seat.peerId = null;
    }
    this.emitLobby();
  }

  private rejectJoin(connection: TransportConnection, reason: JoinRejectionReason): void {
    this.send(connection, 'joinRejected', { reason });
    queueMicrotask(() => connection.close());
  }

  private handleIncoming(record: ConnectionRecord, payload: unknown): void {
    const parsed = parseClientMessage(payload);
    if (!parsed.ok) {
      log.warn('rejected message', parsed.error);
      if (parsed.error === 'protocolMismatch') {
        this.rejectJoin(record.connection, 'protocolMismatch');
      }
      return;
    }
    const message = parsed.message;
    if (message.roomId !== this.roomCode) {
      log.warn('message for another room', message.roomId);
      return;
    }
    if (!record.dedup.accept(message.id)) {
      log.debug('duplicate message dropped', message.id);
      return;
    }

    switch (message.type) {
      case 'joinRequest':
        this.handleJoinRequest(record, message.payload.displayName);
        return;
      case 'resumeRequest':
        this.handleResumeRequest(record, message.payload.playerId, message.payload.resumeToken);
        return;
      case 'ping':
        this.touch(record);
        this.send(record.connection, 'pong', { nonce: message.payload.nonce });
        return;
      case 'pong':
        this.touch(record);
        return;
      case 'action':
        this.touch(record);
        this.handleAction(record, message.payload.action);
        return;
      case 'playAgainVote':
        this.touch(record);
        this.handlePlayAgainVote(record, message.payload.agree);
        return;
      case 'leave':
        this.handleLeave(record);
        return;
    }
  }

  private touch(record: ConnectionRecord): void {
    if (!record.playerId) {
      return;
    }
    const seat = this.seatFor(record.playerId);
    if (!seat) {
      return;
    }
    seat.lastSeenAt = this.now();
    if (seat.health !== 'connected') {
      seat.health = 'connected';
      this.emitLobby();
    }
  }

  private handleJoinRequest(record: ConnectionRecord, requestedName: string): void {
    if (record.playerId) {
      // Already seated; ignore repeats.
      return;
    }
    if (this.phase !== 'lobby') {
      this.rejectJoin(record.connection, 'gameInProgress');
      return;
    }
    if (this.seats.length >= this.maxPlayers) {
      this.rejectJoin(record.connection, 'roomFull');
      return;
    }
    const cleaned = sanitizeDisplayName(requestedName);
    if (cleaned.length === 0) {
      this.rejectJoin(record.connection, 'invalidName');
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
      peerId: record.connection.remoteId,
      lastSeenAt: this.now(),
      health: 'connected',
    };
    this.seats.push(seat);
    record.playerId = seat.playerId;

    this.send(record.connection, 'joinAccepted', {
      playerId: seat.playerId,
      resumeToken: seat.resumeToken,
      displayName: seat.name,
      lobby: this.lobbySnapshot(),
    });
    this.emitLobby();
    log.debug('seated player', seat.name, seat.playerId);
  }

  private handleResumeRequest(record: ConnectionRecord, playerId: string, resumeToken: string): void {
    const seat = this.seatFor(playerId);
    if (!seat || seat.isHost) {
      this.rejectJoin(record.connection, 'unknownSeat');
      return;
    }
    // Constant-time comparison is unnecessary here: the token is a local
    // reconnection secret, not an authentication credential for a shared server.
    if (seat.resumeToken !== resumeToken) {
      this.rejectJoin(record.connection, 'invalidResumeToken');
      return;
    }

    const existing = this.connectionForPlayer(playerId);
    if (existing && existing !== record) {
      existing.playerId = null;
      existing.connection.close();
    }

    record.playerId = seat.playerId;
    seat.peerId = record.connection.remoteId;
    seat.health = 'connected';
    seat.lastSeenAt = this.now();

    this.send(record.connection, 'joinAccepted', {
      playerId: seat.playerId,
      resumeToken: seat.resumeToken,
      displayName: seat.name,
      lobby: this.lobbySnapshot(),
    });
    this.emitLobby();

    if (this.game) {
      this.send(record.connection, 'publicState', { state: toPublicGameState(this.game) });
      this.send(record.connection, 'privateHand', {
        hand: toPrivateHandView(this.game, seat.playerId),
      });
    }
    log.debug('resumed player', seat.name);
  }

  private handleLeave(record: ConnectionRecord): void {
    const playerId = record.playerId;
    record.playerId = null;
    if (playerId) {
      const index = this.seats.findIndex((seat) => seat.playerId === playerId);
      if (index >= 0 && this.phase === 'lobby') {
        this.seats.splice(index, 1);
        this.resequenceSeats();
      } else if (index >= 0) {
        this.seats[index]!.health = 'disconnected';
        this.seats[index]!.peerId = null;
      }
      this.playAgainVotes.delete(playerId);
    }
    record.connection.close();
    this.emitLobby();
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

    const result = createGame(enginePlayers, this.seedFactory());
    if (!result.ok) {
      this.observer({ type: 'error', error: sessionError('unknown', result.rejection.code) });
      return;
    }
    this.game = result.state;
    this.phase = 'inGame';
    this.playAgainVotes.clear();
    this.emitLobby();
    this.broadcastGameState();
    this.emitEvents(result.events);
  }

  private broadcastGameState(): void {
    if (!this.game) {
      return;
    }
    const publicState = toPublicGameState(this.game);
    this.observer({ type: 'publicState', state: publicState });
    this.observer({ type: 'hand', cards: toPrivateHandView(this.game, this.localPlayerId).cards });

    for (const record of this.connections.values()) {
      if (!record.playerId || !record.connection.open) {
        continue;
      }
      this.send(record.connection, 'publicState', { state: publicState });
      this.send(record.connection, 'privateHand', {
        hand: toPrivateHandView(this.game, record.playerId),
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

  private handleAction(record: ConnectionRecord, action: GameAction): void {
    if (!record.playerId) {
      return;
    }
    this.applyAction(record.playerId, action, record);
  }

  private applyAction(playerId: string, action: GameAction, record: ConnectionRecord | null): void {
    if (!this.game || this.phase !== 'inGame') {
      return;
    }
    const command: GameCommand =
      action.type === 'playCard'
        ? {
            type: 'playCard',
            playerId,
            cardId: action.cardId,
            ...(action.chosenColor ? { chosenColor: action.chosenColor } : {}),
          }
        : { type: action.type, playerId };

    const result = applyCommand(this.game, command);
    if (!result.ok) {
      log.debug('rejected action', playerId, action.type, result.rejection.code);
      if (record) {
        this.send(record.connection, 'actionRejected', { code: result.rejection.code });
      } else {
        this.observer({ type: 'actionRejected', code: result.rejection.code });
      }
      return;
    }

    this.game = result.state;
    if (this.game.phase === 'finished') {
      this.phase = 'finished';
      this.playAgainVotes.clear();
      this.emitLobby();
      this.emitPlayAgain();
    }
    this.broadcastGameState();
    this.emitEvents(result.events);
  }

  // -------------------------------------------------------------- play again

  private handlePlayAgainVote(record: ConnectionRecord, agree: boolean): void {
    if (!record.playerId || this.phase !== 'finished') {
      return;
    }
    if (agree) {
      this.playAgainVotes.add(record.playerId);
    } else {
      this.playAgainVotes.delete(record.playerId);
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
    // Drop seats that never came back, then deal a fresh round.
    for (let index = this.seats.length - 1; index >= 0; index -= 1) {
      if (this.seats[index]!.health === 'disconnected') {
        this.seats.splice(index, 1);
      }
    }
    this.resequenceSeats();
    this.playAgainVotes.clear();
    this.phase = 'lobby';
    this.game = null;
    this.startGame();
  }

  // -------------------------------------------------------------- heartbeat

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      this.tickHeartbeat();
    }, intervalMs);
  }

  private tickHeartbeat(): void {
    if (this.destroyed) {
      return;
    }
    const nonce = randomHex(4);
    let changed = false;
    const now = this.now();

    for (const seat of this.seats) {
      if (seat.isHost) {
        continue;
      }
      const record = this.connectionForPlayer(seat.playerId);
      if (!record || !record.connection.open) {
        if (seat.health !== 'disconnected') {
          seat.health = 'disconnected';
          changed = true;
        }
        continue;
      }
      this.send(record.connection, 'ping', { nonce });
      const silence = now - seat.lastSeenAt;
      const next: ConnectionHealth =
        silence > HEARTBEAT.disconnectedAfterMs
          ? 'disconnected'
          : silence > HEARTBEAT.unstableAfterMs
            ? 'unstable'
            : 'connected';
      if (next !== seat.health) {
        seat.health = next;
        changed = true;
      }
    }

    if (changed) {
      this.emitLobby();
    }
  }

  // ---------------------------------------------------------------- teardown

  destroy(reason: SessionClosedReason = 'leftVoluntarily'): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const record of this.connections.values()) {
      if (record.connection.open) {
        this.send(record.connection, 'hostClosed', { reason: 'hostLeft' });
      }
      record.unsubscribe();
      record.connection.close();
    }
    this.connections.clear();
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
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
