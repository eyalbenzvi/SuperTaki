import { record } from '../../../lib/diagnostics.ts';
import { randomHex } from '../../../lib/id.ts';
import { onSleep, onWake } from '../../../lib/lifecycle.ts';
import { createLogger } from '../../../lib/logger.ts';
import { sanitizeDisplayName } from '../../../lib/sanitize.ts';
import { probeReachability } from './reachability.ts';
import { MessageDeduplicator, clientMessage, type MessageContext } from './envelope.ts';
import {
  parseRoomMessage,
  type ClientMessage,
  type GameAction,
  type JoinRejectionReason,
  type LobbySnapshot,
  type RoomCommand,
  type RoomMessage,
} from './protocol.ts';
import { openRoomChannel, RoomError, type ChannelFactory, type RoomChannel } from './roomTransport.ts';
import {
  sessionError,
  type ConnectionPhase,
  type Session,
  type SessionClosedReason,
  type SessionObserver,
} from './session.ts';
import {
  CONNECT_TIMEOUT_FIRST_MS,
  CONNECT_TIMEOUT_RETRY_MS,
  JOIN_TIMEOUT_MS,
  PROBE_DEADLINE_MS,
  SEAT_GRACE_MS,
  backoffDelay,
  reconnectDeadlineMs,
} from './timing.ts';

const log = createLogger('client');

export interface ResumeCredentials {
  readonly playerId: string;
  readonly resumeToken: string;
}

/** Options for the connection that *creates* a room, as opposed to joining one. */
export interface CreateRoomOptions {
  readonly maxPlayers: number;
  readonly tableLanguage: 'he' | 'en';
}

export interface ClientSessionOptions {
  readonly roomCode: string;
  readonly displayName: string;
  readonly observer: SessionObserver;
  /** Present when this connection is opening a brand-new room. */
  readonly create?: CreateRoomOptions;
  /** Present when rejoining an existing seat after a refresh. */
  readonly resume?: ResumeCredentials;
  readonly now?: () => number;
  /** Attempts allowed *before* a seat has been secured. */
  readonly maxAttempts?: number;
  readonly joinTimeoutMs?: number;
  /** How a channel is obtained. Injected by tests, which need no WebSocket. */
  readonly connect?: ChannelFactory;
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
 * A player's connection to their room.
 *
 * Sends *intents* only and renders whatever the room confirms. Snapshots older than
 * the newest one already applied are dropped, so a late-arriving message can never
 * roll the table back.
 *
 * There is one of these per player now, including whoever opened the room. The class
 * that used to sit opposite it — `HostSession`, 2,600 lines of authority running in
 * one player's tab — has no counterpart here: the room is the other side.
 */
export class ClientSession implements Session {
  readonly role = 'client' as const;
  readonly roomCode: string;

  private readonly observer: SessionObserver;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly joinTimeoutMs: number;
  private readonly connectChannel: ChannelFactory;
  /**
   * Session-scoped and never reset.
   *
   * It used to be cleared on every attach, which defeated the entire point:
   * anything the room replays on a fresh channel — and it replays state on every
   * resume by design — was accepted a second time.
   */
  private readonly dedup = new MessageDeduplicator();
  private readonly displayName: string;
  /** Labels this tab in the envelope, for the log. Not an address; nothing is routed. */
  private readonly connectionId = `c-${randomHex(6)}`;
  private readonly create: CreateRoomOptions | null;

  private channel: RoomChannel | null = null;
  private detachChannel: (() => void) | null = null;
  private readonly unsubscribes: Array<() => void> = [];
  private resume: ResumeCredentials | null;
  private playerId: string | null = null;
  private phase: ConnectionPhase = 'idle';
  private attempt = 0;
  private joined = false;
  private destroyed = false;
  /**
   * Set when the room gave a definitive answer (room full, bad token, code taken).
   * Retrying on a timer would only repeat the same rejection, so the UI offers an
   * explicit retry instead.
   */
  private autoRetryDisabled = false;
  private lastRejection: JoinRejectionReason | null = null;
  private lastStateVersion = -1;
  private lastHandVersion = -1;
  private lastEventVersion = -1;
  private lastTurnSeq: number | null = null;
  /** Who we last saw on turn, so the token says what it claims to say. */
  private lastCurrentPlayerId: string | null = null;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Guards against two connects racing.
   *
   * A wake, an `online` event and a channel close can all ask for a reconnect at
   * once. Without a generation the later answer clobbers the earlier one and the room
   * sees two sockets claiming the same seat — one of which it closes as superseded,
   * which looks to the client like being kicked.
   */
  private connectGeneration = 0;
  private connecting = false;
  /** When the give-up deadline expires; derived from the room's own seat grace. */
  private seatGraceMs = SEAT_GRACE_MS;
  private reconnectingSince: number | null = null;
  private outbox: Outbox | null = null;
  /** `false` only while we have positive evidence to the contrary. */
  private online = true;
  /**
   * Settles the first time the room gives a definitive answer to our join.
   *
   * `start()` resolves as soon as a socket is open and the request has gone out,
   * which is the right contract for the connection but the wrong one for the caller:
   * the answer arrives later, on the wire, and a caller that acts on `start()`
   * returning is acting before the room has said anything. That is not a theoretical
   * gap — it is exactly how `createRoom` would fail to notice `roomTaken` and drop
   * the player into the lobby of a room that was already somebody else's.
   */
  private joinSettled: (() => void) | null = null;
  private readonly joinAnswer = new Promise<void>((resolve) => {
    this.joinSettled = resolve;
  });

  constructor(options: ClientSessionOptions) {
    this.observer = options.observer;
    this.roomCode = options.roomCode;
    this.displayName = sanitizeDisplayName(options.displayName) || 'Player';
    this.resume = options.resume ?? null;
    this.create = options.create ?? null;
    // Wrapped rather than captured: taking a reference to `Date.now` freezes whichever
    // implementation was installed when the session was built, which makes the clock
    // unswappable and is a trap for anything that reasons about time passing.
    this.now = options.now ?? ((): number => Date.now());
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.joinTimeoutMs = options.joinTimeoutMs ?? JOIN_TIMEOUT_MS;
    this.connectChannel = options.connect ?? openRoomChannel;

    this.unsubscribes.push(
      onWake((reason) => {
        this.handleWake(reason);
      }),
      onSleep((reason) => {
        if (reason === 'offline') {
          // A hint, not a verdict: `navigator.onLine` is true behind a captive portal
          // and flaps during a network handover, so it may never lengthen into a stop.
          this.online = false;
          record('suspicion', 'browser reports offline');
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

  /** The reason the room gave for refusing us, if it did. */
  get rejection(): JoinRejectionReason | null {
    return this.lastRejection;
  }

  /**
   * Resolves once the room has accepted or refused this seat, or the attempt has
   * given up. Never rejects: the outcome is read from `rejection` and the phase.
   */
  awaitJoin(): Promise<void> {
    return this.joinAnswer;
  }

  private settleJoin(): void {
    this.joinSettled?.();
    this.joinSettled = null;
  }

  /** Starts the connect/join sequence. Resolves once the attempt loop settles. */
  async start(): Promise<void> {
    this.setPhase('connecting');
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
    return this.channel !== null && this.channel.open;
  }

  private fail(error: unknown): void {
    const mapped =
      error instanceof RoomError
        ? sessionError(error.code, error.message)
        : sessionError('unknown', error instanceof Error ? error.message : String(error));
    record('connectFailed', mapped.code, { detail: mapped.detail });
    this.observer({ type: 'error', error: mapped });
    this.setPhase('failed');
    this.settleJoin();
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
   * If the socket looks alive it is still asked to prove it, on a short deadline: a
   * suspended tab very likely had its TCP connection torn down while `readyState`
   * stayed `OPEN`, and believing the socket here is how a player ends up staring at a
   * table that will never update.
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
    this.channel?.probe(PROBE_DEADLINE_MS);
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
    record('connectAttempt', this.roomCode, { attempt: this.attempt, joined: this.joined });

    try {
      const budget = isRetry ? CONNECT_TIMEOUT_RETRY_MS : CONNECT_TIMEOUT_FIRST_MS;
      const channel = await this.connectChannel(this.roomCode, budget);
      if (this.destroyed || generation !== this.connectGeneration) {
        // Superseded while we waited. Closing it matters: a socket left open here is
        // what the room closes as a duplicate claim on our seat.
        channel.close();
        return;
      }
      this.attach(channel);
      this.sendJoin();
      this.attempt = 0;
      this.reconnectingSince = null;
    } catch (error) {
      /*
       * Released here, not only in `finally`. Scheduling the next attempt happens
       * synchronously below, and `scheduleRetry` refuses to arm a timer while a
       * connect is in flight — so leaving this set until `finally` ran silently
       * dropped every retry after the first, leaving the session in `reconnecting`
       * for ever with no attempt, no deadline and nothing said to the player.
       */
      this.connecting = false;
      log.warn('connect attempt failed', this.attempt, error);
      const code = error instanceof RoomError ? error.code : 'unknown';
      record('connectFailed', code, { attempt: this.attempt, joined: this.joined });
      if (
        error instanceof RoomError &&
        (error.code === 'notConfigured' || error.code === 'browserUnsupported')
      ) {
        // Nothing about these improves by trying again.
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
        error: error instanceof RoomError ? sessionError(error.code, error.message) : sessionError('unknown'),
      });
      this.setPhase('reconnecting');
      void this.scheduleRetryChecked();
    } finally {
      this.connecting = false;
    }
  }

  /** True once we have been failing for longer than the room will hold the seat. */
  private deadlineExpired(): boolean {
    if (this.reconnectingSince === null) {
      return false;
    }
    return this.now() - this.reconnectingSince > reconnectDeadlineMs(this.seatGraceMs);
  }

  /**
   * Schedules the next attempt, checking first whether there is any internet.
   *
   * A same-origin request answers that honestly, where `navigator.onLine` does not.
   * Being offline lengthens the wait; it never ends the loop, because the event that
   * would restart it is exactly the one some browsers fail to fire.
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

  private attach(channel: RoomChannel): void {
    this.detach();
    this.channel = channel;

    const offData = channel.onData((payload) => {
      this.handleIncoming(payload);
    });
    const offClose = channel.onClose(() => {
      this.handleClosed();
    });
    const offUnstable = channel.onUnstable(() => {
      record('channelUnstable', this.roomCode);
      if (this.phase === 'connected') {
        this.setPhase('reconnecting');
      }
    });
    this.detachChannel = () => {
      offData();
      offClose();
      offUnstable();
    };
  }

  private detach(): void {
    this.detachChannel?.();
    this.detachChannel = null;
    const previous = this.channel;
    this.channel = null;
    /*
     * Closing what we drop is not tidiness. A detached-but-open socket is still bound
     * to our seat in the room, and the room answers a second socket for one seat by
     * closing the older — which the client would read as being kicked.
     */
    previous?.close();
  }

  private get messageContext(): MessageContext {
    return { roomId: this.roomCode, senderPeerId: this.connectionId, now: this.now };
  }

  private send<TType extends ClientMessage['type']>(
    type: TType,
    payload: Extract<ClientMessage, { type: TType }>['payload'],
  ): boolean {
    if (!this.channel?.open) {
      return false;
    }
    this.channel.send(clientMessage(this.messageContext, type, payload as never));
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
      this.send('joinRequest', {
        displayName: this.displayName,
        // Only on the very first attempt. A retry that still claimed to be creating
        // the room would be answered `roomTaken` by the room we ourselves just made.
        ...(this.create !== null && !this.joined ? { create: this.create } : {}),
      });
    }
    this.joinTimer = setTimeout(() => {
      if (this.joined) {
        return;
      }
      log.warn('join timed out');
      record('connectFailed', 'join timed out');
      /*
       * Not terminal. A lost `joinAccepted` used to end the session for good, with no
       * credential saved either — so the one message whose loss is most costly was
       * also the one nothing recovered from. The room answers a repeated join for a
       * seat it already holds, so trying again is safe.
       */
      this.observer({ type: 'error', error: sessionError('timeout', 'join timed out') });
      this.setPhase('reconnecting');
      this.channel?.close();
    }, this.joinTimeoutMs);
  }

  private handleClosed(): void {
    record('channelClosed', this.roomCode, { joined: this.joined });
    this.detach();
    if (this.destroyed) {
      return;
    }
    if (this.autoRetryDisabled) {
      this.setPhase('failed');
      return;
    }
    if (!this.joined && this.attempt >= this.maxAttempts) {
      this.setPhase('failed');
      this.settleJoin();
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
    const parsed = parseRoomMessage(payload);
    if (!parsed.ok) {
      log.warn('rejected a message from the room', parsed.error);
      if (parsed.error === 'protocolMismatch') {
        this.autoRetryDisabled = true;
        this.observer({ type: 'error', error: sessionError('protocolMismatch') });
      }
      return;
    }
    const message: RoomMessage = parsed.message;
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
        this.settleJoin();
        // Re-ask about whatever was in flight when the socket went, now that there is
        // somewhere to ask.
        this.replayOutbox();
        return;
      }
      case 'joinRejected': {
        const reason = message.payload.reason;
        log.warn('join rejected', reason);
        this.autoRetryDisabled = true;
        this.lastRejection = reason;
        // A stale resume token means the seat is gone; drop it so an explicit retry
        // joins as a new player rather than replaying a dead credential.
        if (reason === 'invalidResumeToken' || reason === 'unknownSeat') {
          this.resume = null;
        }
        this.observer({ type: 'error', error: sessionError(reason) });
        this.setPhase('failed');
        this.settleJoin();
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
        this.lastCurrentPlayerId = state.currentPlayerId;
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
         * Events need a version floor of their own. They were the one payload without
         * one, so a room replaying its log after a reconnect duplicated every line the
         * player had already read.
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
      case 'kicked':
        this.handleKicked(message.payload.reason);
        return;
      case 'roomClosed':
        this.closeWith(message.payload.reason === 'roomReset' ? 'roomReset' : 'roomClosed');
        return;
    }
  }

  private applyLobby(lobby: LobbySnapshot): void {
    if (lobby.seatGraceMs > 0) {
      // The room owns this number. Deriving our deadline from it is what stops the
      // countdown a player is shown from being contradicted by our own timer.
      this.seatGraceMs = lobby.seatGraceMs;
    }
    this.observer({ type: 'lobby', lobby });
  }

  private handleKicked(reason: 'removedByCreator' | 'duplicateConnection'): void {
    if (reason === 'duplicateConnection' && !this.joined) {
      // Our own racing attempt, not another tab. Keep trying.
      record('suspicion', 'closed as a duplicate before joining');
      this.setPhase('reconnecting');
      this.channel?.close();
      return;
    }
    this.closeWith(reason === 'removedByCreator' ? 'removedByCreator' : 'duplicateConnection');
  }

  private closeWith(reason: SessionClosedReason): void {
    this.destroyed = true;
    this.teardown();
    this.setPhase('disconnected');
    this.settleJoin();
    this.observer({ type: 'closed', reason });
  }

  // ------------------------------------------------------------------ actions

  /**
   * Sends one intent and remembers it until it is answered.
   *
   * The turn token travels only for the moves that belong to a turn. Declaring last
   * card, catching somebody who did not, and answering a +3 are legal at any moment
   * and race each other on purpose; gating them on a turn would hand every tie to
   * whichever player broke the rule.
   */
  submitAction(action: GameAction, requestId: string = randomHex(8)): void {
    const turnScoped =
      action.type === 'playCard' || action.type === 'drawCard' || action.type === 'closeTaki';
    this.outbox = {
      requestId,
      action,
      turnSeq: turnScoped ? this.lastTurnSeq : null,
      sentAt: this.now(),
    };
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
      /*
       * `currentPlayerId` is who *we believed* was on turn — not who we are. The room
       * checks only the sequence number, so a field that named the sender would have
       * been a lie nobody caught, and the next reader would have built on it.
       */
      ...(turnScoped && this.lastTurnSeq !== null
        ? { turnToken: { currentPlayerId: this.lastCurrentPlayerId, turnSeq: this.lastTurnSeq } }
        : {}),
    });
  }

  /**
   * Re-asks about the one action in flight.
   *
   * Always re-sent, and judged by the room. Dropping it here when the turn had moved
   * seemed prudent and was actively misleading: on the commonest lost-acknowledgement
   * path the move *was* applied — which is precisely why the turn moved — so the
   * player was told "it is not your turn" about a card they had successfully played.
   * The room answers a request id it has already seen from its own record, and checks
   * the turn token for anything it has not, so it can tell those two cases apart and
   * this cannot.
   */
  private replayOutbox(): void {
    if (!this.outbox) {
      return;
    }
    record('note', 'replaying an unanswered action');
    this.sendOutbox();
  }

  private clearOutbox(requestId?: string): void {
    if (!this.outbox) {
      return;
    }
    if (requestId !== undefined && requestId !== this.outbox.requestId) {
      return;
    }
    this.outbox = null;
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

  /**
   * Asks for a lobby power.
   *
   * Sent by anybody; honoured only for the seat that holds them. The UI hides the
   * buttons from everybody else, but that is a courtesy — the check that matters is
   * the room's, against `creatorPlayerId`.
   */
  roomCommand(command: RoomCommand): void {
    this.send('roomCommand', { command });
  }

  /** Test seam: sends an intent against a turn that has already moved on. */
  submitStaleActionForTests(action: GameAction, requestId: string): void {
    const stale = this.lastTurnSeq === null ? 0 : this.lastTurnSeq - 1;
    this.outbox = { requestId, action, turnSeq: stale, sentAt: this.now() };
    this.send('action', {
      action,
      requestId,
      turnToken: { currentPlayerId: this.lastCurrentPlayerId, turnSeq: stale },
    });
  }

  /** Test seam: re-sends the join handshake, as a client whose accept was lost does. */
  resendJoinForTests(): void {
    this.sendJoin();
  }

  /** Test seam: drops the live socket the way a lost network would. */
  forceReconnectForTests(): void {
    this.channel?.close();
  }

  /** Manual retry, offered by the UI after a failure. */
  retry(): void {
    if (this.destroyed) {
      return;
    }
    this.autoRetryDisabled = false;
    this.lastRejection = null;
    this.attempt = 0;
    this.reconnectingSince = null;
    void this.attemptConnect(true);
  }

  private teardown(): void {
    this.clearTimer('join');
    this.clearTimer('retry');
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes.length = 0;
    this.detach();
  }

  destroy(reason: SessionClosedReason = 'leftVoluntarily'): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.channel?.open) {
      this.send('leave', {});
    }
    this.teardown();
    this.setPhase('disconnected');
    this.settleJoin();
    this.observer({ type: 'closed', reason });
  }
}

export async function createClientSession(options: ClientSessionOptions): Promise<ClientSession> {
  const session = new ClientSession(options);
  await session.start();
  return session;
}
