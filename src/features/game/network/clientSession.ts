import { record } from '../../../lib/diagnostics.ts';
import { randomHex } from '../../../lib/id.ts';
import { onSleep, onWake } from '../../../lib/lifecycle.ts';
import { createLogger } from '../../../lib/logger.ts';
import { sanitizeDisplayName } from '../../../lib/sanitize.ts';
import { probeReachability } from './connectivityProbe.ts';
import { hostPeerIdForRoom } from './roomCode.ts';
import { MessageDeduplicator, clientMessage, type MessageContext } from './envelope.ts';
import {
  parseHostMessage,
  type ClientMessage,
  type GameAction,
  type HostMessage,
  type LobbySnapshot,
} from './protocol.ts';
import {
  sessionError,
  type ConnectionPhase,
  type Session,
  type SessionClosedReason,
  type SessionObserver,
} from './session.ts';
import {
  CHANNEL_DEAD_MS,
  CONNECT_TIMEOUT_FIRST_MS,
  CONNECT_TIMEOUT_RETRY_MS,
  JOIN_TIMEOUT_MS,
  PROBE_DEADLINE_MS,
  SEAT_GRACE_MS,
  UNSTABLE_AFTER_MISSES,
  backoffDelay,
  probeInterval,
  reconnectDeadlineMs,
} from './timing.ts';
import { ProbeTracker, createWatchdog, type Watchdog } from './watchdog.ts';
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
  /** Attempts allowed *before* a seat has been secured. */
  readonly maxAttempts?: number;
  readonly heartbeatIntervalMs?: number;
  readonly joinTimeoutMs?: number;
}

/**
 * Attempts allowed before a seat exists.
 *
 * Bounded on purpose, and only here: a player watching a spinner needs an answer,
 * whereas a seat that has already been secured is worth minutes of patience. The
 * two cases used to share one limit of five, so a phone that lost its signal for
 * half a minute lost the game.
 */
const DEFAULT_MAX_ATTEMPTS = 5;

/** One action in flight, remembered so it can be asked about again. */
interface Outbox {
  readonly requestId: string;
  readonly action: GameAction;
  readonly turnSeq: number | null;
  sentAt: number;
}

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
  hostPeerId: string;

  private readonly transport: Transport;
  private readonly observer: SessionObserver;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly joinTimeoutMs: number;
  private readonly fixedIntervalMs: number | null;
  /**
   * Session-scoped and never reset.
   *
   * It used to be cleared on every attach, which defeated the entire point:
   * anything the host replayed on a fresh channel — and a reconnecting host
   * replays state and events by design — was accepted a second time.
   */
  private readonly dedup = new MessageDeduplicator();
  private readonly probes = new ProbeTracker();
  private readonly displayName: string;

  private connection: TransportConnection | null = null;
  private unsubscribeConnection: (() => void) | null = null;
  private readonly unsubscribes: Array<() => void> = [];
  private resume: ResumeCredentials | null;
  private playerId: string | null = null;
  private phase: ConnectionPhase = 'idle';
  private attempt = 0;
  private joined = false;
  private destroyed = false;
  /**
   * Set when the host gave a definitive answer (room full, bad token).
   * Retrying on a timer would only repeat the same rejection, so the UI offers
   * an explicit retry instead.
   */
  private autoRetryDisabled = false;
  private lastStateVersion = -1;
  private lastHandVersion = -1;
  private lastEventVersion = -1;
  private lastTurnSeq: number | null = null;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: Watchdog | null = null;
  /**
   * Guards against two connects racing.
   *
   * A wake, an `online` event and a channel close can all ask for a reconnect at
   * once. Without a generation the later answer clobbers the earlier one, the host
   * sees two channels from the same peer and kicks one as a duplicate — which the
   * client treats as fatal. Reconnecting eagerly makes that the common case rather
   * than a rarity, so the guard is a prerequisite for the eagerness, not a polish.
   */
  private connectGeneration = 0;
  private connecting = false;
  /** When the give-up deadline expires; derived from the host's own seat grace. */
  private seatGraceMs = SEAT_GRACE_MS;
  private reconnectingSince: number | null = null;
  private outbox: Outbox | null = null;
  /** `false` only while we have positive evidence to the contrary. */
  private online = true;
  private busy = false;

  constructor(options: ClientSessionOptions) {
    this.transport = options.transport;
    this.observer = options.observer;
    this.roomCode = options.roomCode;
    this.hostPeerId = options.hostPeerId;
    this.displayName = sanitizeDisplayName(options.displayName) || 'Player';
    this.resume = options.resume ?? null;
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.joinTimeoutMs = options.joinTimeoutMs ?? JOIN_TIMEOUT_MS;
    this.fixedIntervalMs = options.heartbeatIntervalMs ?? null;

    this.unsubscribes.push(
      onWake((reason) => {
        this.handleWake(reason);
      }),
      onSleep((reason) => {
        if (reason === 'offline') {
          // A hint, not a verdict: `navigator.onLine` is true behind a captive
          // portal and flaps during a network handover, so it may never lengthen
          // into a stop.
          this.online = false;
          record('suspicion', 'browser reports offline');
        }
      }),
      this.transport.onSignallingChange((state) => {
        record('signalling', state);
        if (state === 'up' && !this.isLive()) {
          this.scheduleRetry(0);
        }
      }),
    );
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
    record('phase', phase);
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
    record('connectFailed', mapped.code, { detail: mapped.detail });
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

  // ------------------------------------------------------------------ lifecycle

  /**
   * A wake is new information, so it short-circuits whatever we were waiting for.
   *
   * If the channel looks alive it is still asked to prove it, on a short deadline:
   * a suspended tab very likely lost its ICE consent (the browser gives it 30 s)
   * while `open` stayed true, so believing the channel here is how a player ends
   * up staring at a table that will never update.
   */
  private handleWake(reason: string): void {
    if (this.destroyed) {
      return;
    }
    this.online = true;
    record('wake', `client ${reason}`);
    if (!this.isLive()) {
      this.clearTimer('retry');
      this.attempt = 0;
      void this.attemptConnect(true);
      return;
    }
    this.probes.reset();
    this.sendProbe();
    this.watchdog?.restart();
    setTimeout(() => {
      if (!this.destroyed && this.probes.unanswered > 0 && this.isLive()) {
        log.warn('no answer after waking; rebuilding the channel');
        record('suspicion', 'silent after wake');
        this.connection?.close();
      }
    }, PROBE_DEADLINE_MS);
  }

  // ---------------------------------------------------------------- connecting

  private async attemptConnect(isRetry: boolean): Promise<void> {
    if (this.destroyed || this.connecting) {
      return;
    }
    this.clearTimer('retry');
    this.connecting = true;
    this.connectGeneration += 1;
    const generation = this.connectGeneration;
    this.setPhase(isRetry || this.joined ? 'reconnecting' : 'connecting');
    if (this.reconnectingSince === null) {
      this.reconnectingSince = this.now();
    }
    record('connectAttempt', this.hostPeerId, { attempt: this.attempt, joined: this.joined });

    try {
      const budget = isRetry ? CONNECT_TIMEOUT_RETRY_MS : CONNECT_TIMEOUT_FIRST_MS;
      const connection = await this.transport.connect(this.hostPeerId, budget);
      if (this.destroyed || generation !== this.connectGeneration) {
        // Superseded while we waited. Closing it matters: a channel left open
        // here is what the host kicks as a duplicate.
        connection.close();
        return;
      }
      this.attachConnection(connection);
      this.sendJoin();
      this.attempt = 0;
      this.reconnectingSince = null;
    } catch (error) {
      log.warn('connect attempt failed', this.attempt, error);
      const code = error instanceof TransportError ? error.code : 'unknown';
      record('connectFailed', code, { attempt: this.attempt, joined: this.joined });
      /*
       * "No such peer" before joining means the room code is wrong or the host
       * has closed the page. Retrying cannot change that, and silently backing
       * off would just delay an answer the player needs now. After a seat exists
       * the same error means the opposite — the host is briefly away — so it is
       * retried indefinitely.
       */
      if (!this.joined && error instanceof TransportError && error.code === 'peerUnavailable') {
        this.autoRetryDisabled = true;
        this.fail(error);
        return;
      }
      this.attempt += 1;
      if (!this.joined && this.attempt >= this.maxAttempts) {
        this.fail(error);
        return;
      }
      if (this.joined && this.deadlineExpired()) {
        record('connectFailed', 'gave up: seat grace expired');
        this.fail(error);
        return;
      }
      this.observer({
        type: 'error',
        error:
          error instanceof TransportError ? sessionError(error.code, error.message) : sessionError('unknown'),
      });
      this.setPhase('reconnecting');
      void this.scheduleRetryChecked();
    } finally {
      this.connecting = false;
    }
  }

  /** True once we have been failing for longer than the host will hold the seat. */
  private deadlineExpired(): boolean {
    if (this.reconnectingSince === null) {
      return false;
    }
    return this.now() - this.reconnectingSince > reconnectDeadlineMs(this.seatGraceMs);
  }

  /**
   * Schedules the next attempt, checking first whether there is any internet.
   *
   * A same-origin request answers that honestly, where `navigator.onLine` does
   * not. Being offline lengthens the wait; it never ends the loop, because the
   * event that would restart it is exactly the one some browsers fail to fire.
   */
  private async scheduleRetryChecked(): Promise<void> {
    const delay = backoffDelay(this.attempt - 1);
    if (!this.online) {
      const reachable = await probeReachability();
      this.online = reachable;
      this.scheduleRetry(reachable ? delay : Math.max(delay, 30_000));
      return;
    }
    this.scheduleRetry(delay);
  }

  private scheduleRetry(delay: number): void {
    if (this.destroyed || this.autoRetryDisabled || this.retryTimer !== null || this.connecting) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attemptConnect(true);
    }, delay);
  }

  private attachConnection(connection: TransportConnection): void {
    this.detachConnection();
    this.connection = connection;
    this.probes.reset();

    const offData = connection.onData((payload) => {
      this.handleIncoming(payload);
    });
    const offClose = connection.onClose(() => {
      this.handleClosed();
    });
    const offError = connection.onError((error) => {
      log.warn('connection error', error.code, error.message);
      record('transportError', error.code, { detail: error.message });
    });
    const offUnstable = connection.onUnstable(() => {
      record('channelUnstable', this.hostPeerId);
      if (this.phase === 'connected') {
        this.setPhase('reconnecting');
      }
      this.sendProbe();
    });
    this.unsubscribeConnection = () => {
      offData();
      offClose();
      offError();
      offUnstable();
    };
    this.startWatchdog();
  }

  private detachConnection(): void {
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = null;
    const previous = this.connection;
    this.connection = null;
    this.stopWatchdog();
    /*
     * Closing what we drop is not tidiness. A detached-but-open channel stays
     * registered with the peer, and the host answers a second channel from the
     * same peer id by kicking one of them.
     */
    previous?.close();
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
  ): boolean {
    if (!this.connection?.open) {
      return false;
    }
    this.connection.send(clientMessage(this.messageContext, type, payload as never));
    return true;
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
      if (this.joined) {
        return;
      }
      log.warn('join timed out');
      record('connectFailed', 'join timed out');
      /*
       * Not terminal any more. A lost `joinAccepted` used to end the session for
       * good, with no credential saved either — so the one message whose loss is
       * most costly was also the one nothing recovered from. The host answers a
       * repeated join for a seat it already holds, so trying again is safe.
       */
      this.observer({ type: 'error', error: sessionError('timeout', 'join timed out') });
      this.setPhase('reconnecting');
      this.connection?.close();
    }, this.joinTimeoutMs);
  }

  private handleClosed(): void {
    record('channelClosed', this.hostPeerId, { joined: this.joined });
    this.detachConnection();
    if (this.destroyed) {
      return;
    }
    if (this.autoRetryDisabled) {
      this.setPhase('failed');
      return;
    }
    if (!this.joined && this.attempt >= this.maxAttempts) {
      this.setPhase('failed');
      return;
    }
    if (this.reconnectingSince === null) {
      this.reconnectingSince = this.now();
    }
    if (this.joined && this.deadlineExpired()) {
      this.setPhase('failed');
      return;
    }
    this.setPhase('reconnecting');
    this.attempt += 1;
    void this.scheduleRetryChecked();
  }

  // ------------------------------------------------------------------ messages

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

    switch (message.type) {
      case 'joinAccepted': {
        this.joined = true;
        this.clearTimer('join');
        this.attempt = 0;
        this.reconnectingSince = null;
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
        this.applyLobby(message.payload.lobby);
        this.setPhase('connected');
        // Re-ask about whatever was in flight when the channel went, now that
        // there is somewhere to ask.
        this.replayOutbox();
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
        this.applyLobby(message.payload.lobby);
        return;
      case 'publicState': {
        const state = message.payload.state;
        if (state.version < this.lastStateVersion) {
          log.debug('dropping stale state', state.version, '<', this.lastStateVersion);
          return;
        }
        this.lastStateVersion = state.version;
        this.lastTurnSeq = state.turnSeq ?? null;
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
      case 'gameEvents': {
        /*
         * Events need a version floor of their own. They were the one payload
         * without one, so a host replaying its log after a reconnect duplicated
         * every line the player had already read.
         */
        if (message.payload.version < this.lastEventVersion) {
          return;
        }
        this.lastEventVersion = message.payload.version;
        this.observer({ type: 'events', events: message.payload.events });
        return;
      }
      case 'actionRejected':
        this.clearOutbox(message.payload.requestId);
        this.observer({
          type: 'actionRejected',
          code: message.payload.code,
          ...(message.payload.requestId ? { requestId: message.payload.requestId } : {}),
        });
        return;
      case 'actionAccepted':
        this.clearOutbox(message.payload.requestId);
        this.observer({
          type: 'actionAccepted',
          requestId: message.payload.requestId,
          version: message.payload.version,
        });
        return;
      case 'playAgainState':
        this.observer({
          type: 'playAgain',
          agreed: message.payload.agreed,
          required: message.payload.required,
        });
        return;
      case 'paused':
        this.observer({ type: 'paused', pausedBy: message.payload.pausedBy });
        return;
      case 'nudged':
        this.observer({ type: 'nudged', fromPlayerId: message.payload.fromPlayerId });
        return;
      case 'handoffOffer':
        // Only the store can start a host, so the offer is handed up with the
        // state attached. Nothing is verified here beyond the schema: the offer
        // arrived from the living host on the channel this seat already trusts,
        // which is exactly the condition that makes a handover safe and an
        // automatic takeover from a silent host unsafe.
        this.observer({
          type: 'handoffOffer',
          generation: message.payload.generation,
          snapshot: message.payload.snapshot,
          accept: () => {
            this.send('handoffAccepted', { generation: message.payload.generation });
          },
        });
        return;
      case 'kicked':
        this.handleKicked(message.payload.reason);
        return;
      case 'hostClosed':
        this.handleHostClosed(message.payload);
        return;
      case 'ping':
        this.send('pong', { nonce: message.payload.nonce });
        return;
      case 'pong':
        this.probes.answered(message.payload.nonce, this.now());
        if (this.phase === 'reconnecting' && this.joined && this.isLive()) {
          this.setPhase('connected');
        }
        return;
    }
  }

  private applyLobby(lobby: LobbySnapshot): void {
    if (typeof lobby.seatGraceMs === 'number' && lobby.seatGraceMs > 0) {
      // The host owns this number. Deriving our deadline from it is what stops
      // the countdown a player is shown from being contradicted by our own timer.
      this.seatGraceMs = lobby.seatGraceMs;
    }
    this.observer({ type: 'lobby', lobby });
  }

  private handleKicked(reason: 'removedByHost' | 'duplicateConnection'): void {
    if (reason === 'duplicateConnection' && !this.joined) {
      // Our own racing attempt, not another tab. Keep trying.
      record('suspicion', 'kicked as duplicate before joining');
      this.setPhase('reconnecting');
      this.connection?.close();
      return;
    }
    this.closeWith(reason === 'removedByHost' ? 'removedByHost' : 'duplicateConnection');
  }

  private handleHostClosed(payload: {
    readonly reason: 'hostLeft' | 'roomReset' | 'restarting' | 'handoff';
    readonly generation?: number;
  }): void {
    if (payload.reason === 'restarting') {
      // Not a goodbye. Hold the seat and keep trying.
      record('hostRestart', 'host is restarting');
      this.observer({ type: 'error', error: sessionError('closed', 'host restarting') });
      this.setPhase('reconnecting');
      this.attempt = 0;
      this.reconnectingSince = this.now();
      return;
    }
    if (payload.reason === 'handoff' && payload.generation !== undefined) {
      /*
       * The new host's id is *derived* from the room code and the generation, so
       * there is nothing to look up and nothing to be told: every client can work
       * out where the room went from a single number. That is also why the room
       * code never has to change when a room moves.
       */
      const generation = payload.generation;
      this.hostPeerId = hostPeerIdForRoom(this.roomCode, generation);
      record('handover', this.hostPeerId, { generation });
      this.observer({ type: 'handover', generation });
      this.setPhase('reconnecting');
      this.attempt = 0;
      this.reconnectingSince = this.now();
      this.connection?.close();
      return;
    }
    this.closeWith(payload.reason === 'roomReset' ? 'roomReset' : 'hostLeft');
  }

  private closeWith(reason: SessionClosedReason): void {
    this.destroyed = true;
    this.teardown();
    this.setPhase('disconnected');
    this.observer({ type: 'closed', reason });
  }

  // ----------------------------------------------------------------- heartbeat

  private currentInterval(): number {
    return this.fixedIntervalMs ?? probeInterval(this.busy);
  }

  private sendProbe(): void {
    const nonce = randomHex(4);
    if (this.send('ping', { nonce })) {
      this.probes.sent(nonce, this.now());
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = createWatchdog({
      intervalMs: () => this.currentInterval(),
      now: this.now,
      onTick: (tick) => {
        if (!this.isLive()) {
          return;
        }
        if (tick.late) {
          /*
           * We were asleep, so the peer is not on trial. But nor is it presumed
           * well: extending grace is exactly wrong when a suspension has very
           * likely already killed the channel. Ask now, on a short deadline.
           */
          record('suspicion', 'watchdog tick was late', { elapsedMs: tick.elapsedMs });
          this.probes.reset();
          this.sendProbe();
          return;
        }
        this.sendProbe();
        const oldest = this.probes.oldestAgeMs(this.now());
        if (oldest !== null && oldest > CHANNEL_DEAD_MS) {
          log.warn('host stopped answering; rebuilding the channel');
          record('suspicion', 'probes unanswered past the channel deadline', { oldest });
          this.connection?.close();
          return;
        }
        if (this.probes.unanswered >= UNSTABLE_AFTER_MISSES && this.phase === 'connected') {
          this.setPhase('reconnecting');
        }
      },
    });
  }

  private stopWatchdog(): void {
    this.watchdog?.stop();
    this.watchdog = null;
  }

  // ------------------------------------------------------------------ actions

  /**
   * Sends one intent and remembers it until it is answered.
   *
   * The turn token travels only for the moves that belong to a turn. Declaring
   * last card, catching somebody who did not, and answering a +3 are legal at any
   * moment and race each other on purpose; gating them on a turn would hand every
   * tie to whichever player broke the rule.
   */
  submitAction(action: GameAction, requestId: string = randomHex(8)): void {
    const turnScoped = action.type === 'drawCard' || action.type === 'closeTaki';
    this.outbox = {
      requestId,
      action,
      turnSeq: turnScoped ? this.lastTurnSeq : null,
      sentAt: this.now(),
    };
    this.busy = true;
    this.sendOutbox();
  }

  private sendOutbox(): void {
    const pending = this.outbox;
    if (!pending) {
      return;
    }
    const turnScoped = pending.turnSeq !== null;
    this.send('action', {
      action: pending.action,
      requestId: pending.requestId,
      ...(turnScoped && this.lastTurnSeq !== null
        ? { turnToken: { currentPlayerId: this.playerId, turnSeq: this.lastTurnSeq } }
        : {}),
    });
  }

  /**
   * Re-asks about the one action in flight, if it can still mean what it meant.
   *
   * A turn-scoped intent whose turn has since moved on is dropped rather than
   * replayed: a card that was legal three moves ago may be illegal now, or already
   * played. An out-of-turn intent has no such problem and is always safe to repeat,
   * because the host answers a request id it has already seen with the same answer
   * rather than applying it twice.
   */
  private replayOutbox(): void {
    const pending = this.outbox;
    if (!pending) {
      return;
    }
    if (pending.turnSeq !== null && pending.turnSeq !== this.lastTurnSeq) {
      record('note', 'dropped a stale action after reconnecting');
      this.outbox = null;
      this.busy = false;
      this.observer({ type: 'actionRejected', code: 'notYourTurn', requestId: pending.requestId });
      return;
    }
    record('note', 'replaying an unanswered action');
    this.sendOutbox();
  }

  private clearOutbox(requestId?: string): void {
    if (!this.outbox) {
      // Nothing in flight, so nothing is at stake: never leave the probe cadence
      // stuck at its busy rate on the strength of an answer we cannot match.
      this.busy = false;
      return;
    }
    if (requestId !== undefined && requestId !== this.outbox.requestId) {
      return;
    }
    this.outbox = null;
    this.busy = false;
  }

  votePlayAgain(agree: boolean): void {
    this.send('playAgainVote', { agree });
  }

  requestPause(paused: boolean): void {
    this.send('pauseRequest', { paused });
  }

  voteAbandon(agree: boolean): void {
    this.send('abandonVote', { agree });
  }

  nudge(targetPlayerId: string): void {
    this.send('nudge', { targetPlayerId });
  }

  /** Tells the heartbeat that this player has something at stake. */
  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /** Manual retry, offered by the UI after a failure. */
  retry(): void {
    if (this.destroyed) {
      return;
    }
    this.autoRetryDisabled = false;
    this.attempt = 0;
    this.reconnectingSince = null;
    void this.attemptConnect(true);
  }

  private teardown(): void {
    this.clearTimer('join');
    this.clearTimer('retry');
    this.stopWatchdog();
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes.length = 0;
    this.detachConnection();
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
