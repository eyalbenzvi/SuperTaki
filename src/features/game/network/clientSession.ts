import { randomHex } from '../../../lib/id.ts';
import { createLogger } from '../../../lib/logger.ts';
import { sanitizeDisplayName } from '../../../lib/sanitize.ts';
import { MessageDeduplicator, clientMessage, type MessageContext } from './envelope.ts';
import { parseHostMessage, type ClientMessage, type GameAction, type HostMessage } from './protocol.ts';
import {
  HEARTBEAT,
  backoffDelay,
  sessionError,
  type ConnectionPhase,
  type Session,
  type SessionClosedReason,
  type SessionObserver,
} from './session.ts';
import { TransportError, type Transport, type TransportConnection } from './transport.ts';

const log = createLogger('client');

export interface ResumeCredentials {
  readonly playerId: string;
  readonly resumeToken: string;
}

export interface ClientSessionOptions {
  readonly transport: Transport;
  readonly roomCode: string;
  readonly hostPeerId: string;
  readonly displayName: string;
  readonly observer: SessionObserver;
  /** Present when rejoining an existing seat after a refresh. */
  readonly resume?: ResumeCredentials;
  readonly now?: () => number;
  readonly maxAttempts?: number;
  readonly heartbeatIntervalMs?: number;
  readonly joinTimeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_JOIN_TIMEOUT_MS = 12_000;

/**
 * A non-authoritative peer.
 *
 * Sends *intents* only and renders whatever the host confirms. Snapshots older
 * than the newest one already applied are dropped, so a late-arriving message
 * can never roll the table back.
 */
export class ClientSession implements Session {
  readonly role = 'client' as const;
  readonly roomCode: string;
  readonly hostPeerId: string;

  private readonly transport: Transport;
  private readonly observer: SessionObserver;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly joinTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly dedup = new MessageDeduplicator();
  private readonly displayName: string;

  private connection: TransportConnection | null = null;
  private unsubscribeConnection: (() => void) | null = null;
  private resume: ResumeCredentials | null;
  private playerId: string | null = null;
  private phase: ConnectionPhase = 'idle';
  private attempt = 0;
  private joined = false;
  private destroyed = false;
  /**
   * Set when the host gave a definitive answer (room full, bad token, timeout).
   * Retrying on a timer would only repeat the same rejection, so the UI offers
   * an explicit retry instead.
   */
  private autoRetryDisabled = false;
  private lastStateVersion = -1;
  private lastHandVersion = -1;
  private lastHostMessageAt = 0;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onOffline = (): void => {
    log.warn('browser went offline');
    this.setPhase('disconnected');
  };
  private readonly onOnline = (): void => {
    log.debug('browser back online');
    if (!this.destroyed && !this.isLive()) {
      void this.attemptConnect(true);
    }
  };

  constructor(options: ClientSessionOptions) {
    this.transport = options.transport;
    this.observer = options.observer;
    this.roomCode = options.roomCode;
    this.hostPeerId = options.hostPeerId;
    this.displayName = sanitizeDisplayName(options.displayName) || 'Player';
    this.resume = options.resume ?? null;
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.joinTimeoutMs = options.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT.intervalMs;

    if (typeof window !== 'undefined') {
      window.addEventListener('offline', this.onOffline);
      window.addEventListener('online', this.onOnline);
    }
  }

  get localPlayerId(): string {
    return this.playerId ?? '';
  }

  get connectionPhase(): ConnectionPhase {
    return this.phase;
  }

  /** Starts the connect/join sequence. Resolves once the attempt loop settles. */
  async start(): Promise<void> {
    this.setPhase('initializing');
    try {
      await this.transport.ready();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.setPhase('ready');
    await this.attemptConnect(false);
  }

  private setPhase(phase: ConnectionPhase): void {
    if (this.phase === phase) {
      return;
    }
    this.phase = phase;
    this.observer({ type: 'phase', phase });
  }

  private isLive(): boolean {
    return this.connection !== null && this.connection.open;
  }

  private fail(error: unknown): void {
    const mapped =
      error instanceof TransportError
        ? sessionError(error.code, error.message)
        : sessionError('unknown', error instanceof Error ? error.message : String(error));
    this.observer({ type: 'error', error: mapped });
    this.setPhase('failed');
  }

  private clearTimer(which: 'join' | 'retry'): void {
    const timer = which === 'join' ? this.joinTimer : this.retryTimer;
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (which === 'join') {
      this.joinTimer = null;
    } else {
      this.retryTimer = null;
    }
  }

  private async attemptConnect(isRetry: boolean): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.clearTimer('retry');
    this.setPhase(isRetry || this.joined ? 'reconnecting' : 'connecting');

    try {
      const connection = await this.transport.connect(this.hostPeerId);
      if (this.destroyed) {
        connection.close();
        return;
      }
      this.attachConnection(connection);
      this.sendJoin();
      this.attempt = 0;
    } catch (error) {
      log.warn('connect attempt failed', this.attempt, error);
      this.attempt += 1;
      if (this.attempt >= this.maxAttempts) {
        this.fail(error);
        return;
      }
      const delay = backoffDelay(this.attempt - 1);
      this.observer({
        type: 'error',
        error:
          error instanceof TransportError ? sessionError(error.code, error.message) : sessionError('unknown'),
      });
      this.setPhase('reconnecting');
      this.retryTimer = setTimeout(() => {
        void this.attemptConnect(true);
      }, delay);
    }
  }

  private attachConnection(connection: TransportConnection): void {
    this.detachConnection();
    this.connection = connection;
    this.dedup.reset();
    this.lastHostMessageAt = this.now();

    const offData = connection.onData((payload) => {
      this.handleIncoming(payload);
    });
    const offClose = connection.onClose(() => {
      this.handleClosed();
    });
    const offError = connection.onError((error) => {
      log.warn('connection error', error.code, error.message);
    });
    this.unsubscribeConnection = () => {
      offData();
      offClose();
      offError();
    };
    this.startHeartbeat();
  }

  private detachConnection(): void {
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = null;
    this.connection = null;
    this.stopHeartbeat();
  }

  private get messageContext(): MessageContext {
    return {
      roomId: this.roomCode,
      senderPeerId: this.transport.localId ?? 'unknown',
      now: this.now,
    };
  }

  private send<TType extends ClientMessage['type']>(
    type: TType,
    payload: Extract<ClientMessage, { type: TType }>['payload'],
  ): void {
    if (!this.connection?.open) {
      return;
    }
    this.connection.send(clientMessage(this.messageContext, type, payload as never));
  }

  private sendJoin(): void {
    this.clearTimer('join');
    if (this.resume) {
      this.send('resumeRequest', {
        playerId: this.resume.playerId,
        resumeToken: this.resume.resumeToken,
      });
    } else {
      this.send('joinRequest', { displayName: this.displayName });
    }
    this.joinTimer = setTimeout(() => {
      if (!this.joined) {
        log.warn('join timed out');
        this.autoRetryDisabled = true;
        this.observer({ type: 'error', error: sessionError('timeout', 'join timed out') });
        this.setPhase('failed');
        this.connection?.close();
      }
    }, this.joinTimeoutMs);
  }

  private handleClosed(): void {
    this.detachConnection();
    if (this.destroyed) {
      return;
    }
    if (this.autoRetryDisabled) {
      this.setPhase('failed');
      return;
    }
    if (this.attempt >= this.maxAttempts) {
      this.setPhase('failed');
      return;
    }
    this.setPhase('reconnecting');
    this.attempt += 1;
    const delay = backoffDelay(this.attempt - 1);
    this.retryTimer = setTimeout(() => {
      void this.attemptConnect(true);
    }, delay);
  }

  private handleIncoming(payload: unknown): void {
    const parsed = parseHostMessage(payload);
    if (!parsed.ok) {
      log.warn('rejected host message', parsed.error);
      if (parsed.error === 'protocolMismatch') {
        this.observer({ type: 'error', error: sessionError('protocolMismatch') });
      }
      return;
    }
    const message: HostMessage = parsed.message;
    if (message.roomId !== this.roomCode) {
      return;
    }
    if (!this.dedup.accept(message.id)) {
      return;
    }
    this.lastHostMessageAt = this.now();

    switch (message.type) {
      case 'joinAccepted': {
        this.joined = true;
        this.clearTimer('join');
        this.playerId = message.payload.playerId;
        this.resume = {
          playerId: message.payload.playerId,
          resumeToken: message.payload.resumeToken,
        };
        this.observer({
          type: 'identity',
          playerId: message.payload.playerId,
          resumeToken: message.payload.resumeToken,
          displayName: message.payload.displayName,
        });
        this.observer({ type: 'lobby', lobby: message.payload.lobby });
        this.setPhase('connected');
        return;
      }
      case 'joinRejected': {
        const reason = message.payload.reason;
        log.warn('join rejected', reason);
        this.autoRetryDisabled = true;
        // A stale resume token means the seat is gone; drop it so an explicit
        // retry joins as a new player instead of replaying a dead credential.
        if (reason === 'invalidResumeToken' || reason === 'unknownSeat') {
          this.resume = null;
        }
        this.observer({ type: 'error', error: sessionError(reason) });
        this.setPhase('failed');
        return;
      }
      case 'lobbyState':
        this.observer({ type: 'lobby', lobby: message.payload.lobby });
        return;
      case 'publicState': {
        const state = message.payload.state;
        if (state.version < this.lastStateVersion) {
          log.debug('dropping stale state', state.version, '<', this.lastStateVersion);
          return;
        }
        this.lastStateVersion = state.version;
        this.observer({ type: 'publicState', state });
        return;
      }
      case 'privateHand': {
        const hand = message.payload.hand;
        if (this.playerId && hand.playerId !== this.playerId) {
          log.warn('ignoring a hand that belongs to another player');
          return;
        }
        if (hand.version < this.lastHandVersion) {
          return;
        }
        this.lastHandVersion = hand.version;
        this.observer({ type: 'hand', cards: hand.cards });
        return;
      }
      case 'gameEvents':
        this.observer({ type: 'events', events: message.payload.events });
        return;
      case 'actionRejected':
        this.observer({ type: 'actionRejected', code: message.payload.code });
        return;
      case 'playAgainState':
        this.observer({
          type: 'playAgain',
          agreed: message.payload.agreed,
          required: message.payload.required,
        });
        return;
      case 'kicked':
        this.closeWith(message.payload.reason === 'removedByHost' ? 'removedByHost' : 'duplicateConnection');
        return;
      case 'hostClosed':
        this.closeWith(message.payload.reason === 'roomReset' ? 'roomReset' : 'hostLeft');
        return;
      case 'ping':
        this.send('pong', { nonce: message.payload.nonce });
        return;
      case 'pong':
        return;
    }
  }

  private closeWith(reason: SessionClosedReason): void {
    this.destroyed = true;
    this.teardown();
    this.setPhase('disconnected');
    this.observer({ type: 'closed', reason });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isLive()) {
        return;
      }
      this.send('ping', { nonce: randomHex(4) });
      const silence = this.now() - this.lastHostMessageAt;
      if (silence > HEARTBEAT.disconnectedAfterMs) {
        log.warn('host went silent; forcing a reconnect');
        this.connection?.close();
      } else if (silence > HEARTBEAT.unstableAfterMs && this.phase === 'connected') {
        this.setPhase('reconnecting');
      } else if (silence <= HEARTBEAT.unstableAfterMs && this.phase === 'reconnecting' && this.joined) {
        this.setPhase('connected');
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ------------------------------------------------------------------ actions

  submitAction(action: GameAction): void {
    this.send('action', { action });
  }

  votePlayAgain(agree: boolean): void {
    this.send('playAgainVote', { agree });
  }

  /** Manual retry, offered by the UI after a failure. */
  retry(): void {
    if (this.destroyed) {
      return;
    }
    this.autoRetryDisabled = false;
    this.attempt = 0;
    void this.attemptConnect(true);
  }

  private teardown(): void {
    this.clearTimer('join');
    this.clearTimer('retry');
    this.stopHeartbeat();
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', this.onOffline);
      window.removeEventListener('online', this.onOnline);
    }
    const connection = this.connection;
    this.detachConnection();
    connection?.close();
    this.transport.destroy();
  }

  destroy(reason: SessionClosedReason = 'leftVoluntarily'): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.connection?.open) {
      this.send('leave', {});
    }
    this.teardown();
    this.setPhase('disconnected');
    this.observer({ type: 'closed', reason });
  }
}

export async function createClientSession(options: ClientSessionOptions): Promise<ClientSession> {
  const session = new ClientSession(options);
  await session.start();
  return session;
}
