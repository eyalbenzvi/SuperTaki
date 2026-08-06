/**
 * A whole room, in plain Node.
 *
 * `GameRoom` takes its sockets, its storage, its alarm queue and its clock as
 * arguments, so none of workerd is needed to drive one — which is the point of the
 * shape, and the reason these tests can play a full round in a millisecond and
 * assert on every frame that crossed the wire.
 *
 * The clock is manual. Nothing here waits: `advance()` moves time and fires
 * whatever the room booked, exactly as the platform would.
 */

import { AlarmMux, memoryAlarms } from '../src/alarms.ts';
import { GameRoom, type RoomSocket } from '../src/gameRoom.ts';
import { memoryStore, type RoomStore } from '../src/storage.ts';
import { clientMessage } from '../../src/features/game/network/envelope.ts';
import {
  parseRoomMessage,
  type ClientMessage,
  type LobbySnapshot,
  type RoomMessage,
} from '../../src/features/game/network/protocol.ts';
import { cardColor, requiresColorChoice, type Card } from '../../src/features/game/engine/cards.ts';
import { getPlayableCardIds } from '../../src/features/game/engine/rules.ts';
import { playContextFromPublic, type PublicGameState } from '../../src/features/game/engine/views.ts';

/** One client, with everything the room ever said to it. */
export class TestClient implements RoomSocket {
  readonly received: RoomMessage[] = [];
  /** Every raw frame, so a privacy test can search the bytes rather than the model. */
  readonly rawFrames: string[] = [];
  closed: { code: number; reason: string } | null = null;

  /**
   * What this client currently believes, kept the way a real client keeps it.
   *
   * Separate from `received`, and deliberately *not* cleared by `forget()`. A real
   * client accumulates a view of the table and does not lose it when it stops caring
   * about old messages — and a test that says "ignore what happened before now, then
   * take a turn" needs both halves of that.
   */
  state: PublicGameState | null = null;
  hand: readonly Card[] = [];
  lobby: LobbySnapshot | null = null;

  constructor(
    readonly label: string,
    private readonly room: Harness,
  ) {}

  send(data: string): void {
    this.rawFrames.push(data);
    const parsed = parseRoomMessage(JSON.parse(data) as unknown);
    if (!parsed.ok) {
      throw new Error(`${this.label} was sent an unparseable frame: ${parsed.error} — ${data}`);
    }
    const message = parsed.message;
    this.received.push(message);
    switch (message.type) {
      case 'publicState':
        this.state = message.payload.state;
        break;
      case 'privateHand':
        this.hand = message.payload.hand.cards;
        break;
      case 'joinAccepted':
        this.lobby = message.payload.lobby;
        break;
      case 'lobbyState':
        this.lobby = message.payload.lobby;
        break;
      default:
        break;
    }
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  /** Sends a client message, as a real socket would deliver it. */
  say<TType extends ClientMessage['type']>(
    type: TType,
    payload: Extract<ClientMessage, { type: TType }>['payload'],
  ): void {
    const message = clientMessage(
      { roomId: this.room.roomCode, senderPeerId: this.label, now: () => this.room.now() },
      type,
      payload as never,
    );
    this.room.room.handleMessage(this, JSON.stringify(message));
  }

  /** Every message of a type, oldest first. */
  all<TType extends RoomMessage['type']>(type: TType): Extract<RoomMessage, { type: TType }>[] {
    return this.received.filter((m): m is Extract<RoomMessage, { type: TType }> => m.type === type);
  }

  /** The newest message of a type, or `undefined`. */
  last<TType extends RoomMessage['type']>(type: TType): Extract<RoomMessage, { type: TType }> | undefined {
    return this.all(type).at(-1);
  }

  /** The newest message of a type, or a failed assertion. */
  expect<TType extends RoomMessage['type']>(type: TType): Extract<RoomMessage, { type: TType }> {
    const found = this.last(type);
    if (found === undefined) {
      throw new Error(
        `${this.label} never received a ${type}; it received: ${this.received.map((m) => m.type).join(', ')}`,
      );
    }
    return found;
  }

  forget(): void {
    this.received.length = 0;
    this.rawFrames.length = 0;
  }

  /**
   * How many intents this client has sent, ever.
   *
   * Counted separately from anything `forget()` clears, and that is the whole reason it
   * exists. The default request id used to be derived from `received.length`, so a test
   * that called `forget()` between moves restarted the numbering — and the room, quite
   * correctly, answered every move after the first as a replay of one it had already
   * applied. The table stopped moving and the test carried on looking at it.
   */
  private intents = 0;

  /**
   * Makes one legal move, the way the real UI would.
   *
   * Legality comes from the engine's own `rules.ts` against the same public
   * projection a browser gets, so this is a player rather than a puppet: it cannot
   * make a move the room would refuse, and a round driven by it terminates for the
   * same reason a real one does.
   */
  takeTurn(requestId = `rq-${this.label}-${String((this.intents += 1))}`): void {
    const state = this.state;
    if (state === null) {
      throw new Error(`${this.label} has no table to play against`);
    }

    // An open +3 freezes every other seat until it is answered, so it comes first.
    if (state.plusThree !== null) {
      const breaker = this.hand.find((card) => card.kind === 'breakPlusThree');
      this.say('action', {
        action: breaker ? { type: 'playCard', cardId: breaker.id } : { type: 'passBreak' },
        requestId,
      });
      return;
    }

    const playable = new Set(getPlayableCardIds(this.hand, playContextFromPublic(state)));
    const card = this.hand.find((candidate) => playable.has(candidate.id));
    if (card !== undefined) {
      this.say('action', {
        action: requiresColorChoice(card)
          ? { type: 'playCard', cardId: card.id, chosenColor: this.bestColor() }
          : { type: 'playCard', cardId: card.id },
        requestId,
      });
      return;
    }

    // Nothing to play. Inside a sequence of my own that means closing it; drawing is
    // refused during a Taki, which is the rule the engine enforces here.
    if (state.takiMode !== null && state.takiMode.playerId === state.currentPlayerId) {
      this.say('action', { action: { type: 'closeTaki' }, requestId });
      return;
    }
    this.say('action', { action: { type: 'drawCard' }, requestId });
  }

  /** The colour this hand has most of, for a wild card. */
  private bestColor(): 'red' | 'blue' | 'green' | 'yellow' {
    const counts = new Map<string, number>();
    for (const card of this.hand) {
      const color = cardColor(card);
      if (color !== null) {
        counts.set(color, (counts.get(color) ?? 0) + 1);
      }
    }
    let best: 'red' | 'blue' | 'green' | 'yellow' = 'red';
    let seen = -1;
    for (const color of ['red', 'blue', 'green', 'yellow'] as const) {
      const count = counts.get(color) ?? 0;
      if (count > seen) {
        seen = count;
        best = color;
      }
    }
    return best;
  }
}

export interface HarnessOptions {
  readonly roomCode?: string;
  readonly startAt?: number;
  /** Fixed seed, so a round is the same round every run. */
  readonly seed?: number;
  /** Robots answer instantly by default; a test that wants pacing overrides it. */
  readonly botPauseMs?: () => number;
  readonly store?: RoomStore;
}

/** A room, its clock, its storage and its alarm queue, wired together. */
export class Harness {
  readonly roomCode: string;
  readonly store: RoomStore;
  readonly logs: string[] = [];
  private clock: number;
  private readonly alarms: ReturnType<typeof memoryAlarms>;
  room: GameRoom;

  constructor(private readonly options: HarnessOptions = {}) {
    this.roomCode = options.roomCode ?? '123456';
    this.clock = options.startAt ?? 1_000_000;
    this.store = options.store ?? memoryStore();
    this.alarms = memoryAlarms();
    this.room = this.build();
  }

  private build(restore?: readonly { socket: RoomSocket; playerId: string }[]): GameRoom {
    return new GameRoom({
      roomCode: this.roomCode,
      store: this.store,
      alarms: new AlarmMux(this.alarms, this.alarms),
      now: () => this.clock,
      seedFactory: () => this.options.seed ?? 20260806,
      botPauseMs: this.options.botPauseMs ?? ((): number => 0),
      log: (message, detail) => {
        this.logs.push(detail ? `${message} ${JSON.stringify(detail)}` : message);
      },
      ...(restore ? { restore } : {}),
    });
  }

  now(): number {
    return this.clock;
  }

  client(label: string): TestClient {
    return new TestClient(label, this);
  }

  /** Seats a fresh player and returns their client and credentials. */
  join(
    label: string,
    options: { create?: { maxPlayers: number; tableLanguage: 'he' | 'en' } } = {},
  ): {
    client: TestClient;
    playerId: string;
    resumeToken: string;
  } {
    const client = this.client(label);
    client.say('joinRequest', {
      displayName: label,
      ...(options.create ? { create: options.create } : {}),
    });
    const accepted = client.expect('joinAccepted');
    return { client, playerId: accepted.payload.playerId, resumeToken: accepted.payload.resumeToken };
  }

  /**
   * Moves the clock, firing every alarm that comes due on the way.
   *
   * Alarms are fired one *batch* per due deadline rather than all at the end, because
   * a handler routinely books the next one — a skip that moves the turn to another
   * absent seat, say — and collapsing that into a single wake would skip states the
   * real platform would pass through.
   */
  advance(ms: number): void {
    const target = this.clock + ms;
    let guard = 0;
    for (;;) {
      const next = this.alarms.armedAt;
      if (next === null || next > target) {
        break;
      }
      this.clock = Math.max(next, this.clock);
      this.fire();
      if ((guard += 1) > 1000) {
        throw new Error('the room kept re-arming its alarm: a runaway alarm loop');
      }
    }
    this.clock = target;
  }

  /**
   * Whether the room has asked to be forgotten.
   *
   * The adapter is what deletes storage, so in the real object this is the return
   * value of `alarm()`; here it is latched, because a test wants to ask about it
   * after the fact rather than at the moment it happened.
   */
  forgotten = false;

  /**
   * How many times the platform alarm has fired.
   *
   * On Cloudflare one wake is one billed request, so this is the number the zero-cost
   * claim rests on and a test is allowed to assert an exact bound on it. It also
   * catches the failure `advance`'s runaway guard only catches at the extreme: a
   * deadline that is recomputed to a moment already past is re-booked at the alarm
   * floor for ever, which is a 1 Hz loop rather than a tight one.
   */
  wakes = 0;

  /** Fires the alarm now, whatever it was set for. */
  fire(): void {
    this.wakes += 1;
    if (this.room.handleAlarm()) {
      this.forgotten = true;
      // What the adapter does next: the object's storage goes, and with it the room.
      for (const key of ['room', 'game']) {
        this.store.delete(key);
      }
    }
  }

  /** What the platform's single alarm is currently set to. */
  get armedAt(): number | null {
    return this.alarms.armedAt;
  }

  /** Every deadline the room is currently keeping, earliest first. */
  pendingAlarms(): { kind: string; at: number }[] {
    return [...this.alarms.entries()].sort((a, b) => a.at - b.at);
  }

  /**
   * Evicts the room from memory and builds it again from storage.
   *
   * What a hibernation does. Every test that claims something survives one should go
   * through here rather than trusting the in-memory object, because the whole promise
   * of this design is that the object's memory is disposable.
   */
  hibernate(live: readonly { socket: RoomSocket; playerId: string }[] = []): void {
    this.room = this.build(live);
  }
}
