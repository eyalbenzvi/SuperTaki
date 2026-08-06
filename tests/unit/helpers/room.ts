/**
 * A real room, in the app's own test process.
 *
 * `ClientSession` takes its channel factory as an option, so a test can hand it
 * something other than a WebSocket. What it is handed here is not a stub: it is the
 * actual `GameRoom` from `worker/src`, driven over an in-memory pipe.
 *
 * That is a deliberate upgrade on what this replaced. The old helper built a
 * `MemoryNetwork` and put a `HostSession` on the other end — which was fine, because
 * the host was app code. The authority is the worker's now, and a *scripted* fake of
 * it would only ever assert that the client agrees with the test author's memory of
 * the protocol. Running the real thing means these tests fail when the two sides
 * actually disagree, which is the only failure worth catching here.
 *
 * The clock is manual, so nothing waits and alarms fire when a test says so.
 */

import { AlarmMux, memoryAlarms } from '../../../worker/src/alarms.ts';
import { GameRoom, type RoomSocket } from '../../../worker/src/gameRoom.ts';
import { memoryStore, type RoomStore } from '../../../worker/src/storage.ts';
import type { ChannelFactory, RoomChannel } from '../../../src/features/game/network/roomTransport.ts';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type RoomMessage,
} from '../../../src/features/game/network/protocol.ts';
import type { SessionUpdate } from '../../../src/features/game/network/session.ts';

export const TEST_ROOM = '482913';

/** Lets queued microtasks and timer callbacks drain. */
export async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** Collects session updates and offers convenient lookups. */
export function createRecorder(): {
  observer: (update: SessionUpdate) => void;
  updates: SessionUpdate[];
  ofType: <TType extends SessionUpdate['type']>(type: TType) => Extract<SessionUpdate, { type: TType }>[];
  last: <TType extends SessionUpdate['type']>(
    type: TType,
  ) => Extract<SessionUpdate, { type: TType }> | undefined;
  clear: () => void;
} {
  const updates: SessionUpdate[] = [];
  const ofType = <TType extends SessionUpdate['type']>(
    type: TType,
  ): Extract<SessionUpdate, { type: TType }>[] =>
    updates.filter((update): update is Extract<SessionUpdate, { type: TType }> => update.type === type);

  return {
    observer: (update) => {
      updates.push(update);
    },
    updates,
    ofType,
    last: (type) => ofType(type).at(-1),
    clear: () => {
      updates.length = 0;
    },
  };
}

/** One end of an in-memory pipe: what the client sees, and what the room sees. */
class PipedChannel implements RoomChannel {
  private dataHandlers = new Set<(data: unknown) => void>();
  private closeHandlers = new Set<() => void>();
  private unstableHandlers = new Set<() => void>();
  private isOpen = true;
  /** The room's side of this pipe. */
  readonly socket: RoomSocket;

  constructor(
    private readonly server: TestRoom,
    private readonly roomCode: string,
  ) {
    this.socket = {
      /*
       * Delivered on a microtask, not inline. A real socket never answers inside the
       * call that sent the question, and a pipe that does hides every bug that lives in
       * the gap — most obviously the move lock, which would be taken and released
       * before `playCard` had returned.
       */
      send: (raw: string): void => {
        if (!this.isOpen) {
          return;
        }
        const frame: unknown = JSON.parse(raw);
        queueMicrotask(() => {
          if (!this.isOpen) {
            return;
          }
          for (const handler of [...this.dataHandlers]) {
            handler(frame);
          }
        });
      },
      /*
       * Queued behind whatever is already on the wire, not taken immediately. A room
       * that refuses a join sends the refusal and *then* closes; a real socket delivers
       * those in that order, and a pipe that tore the channel down first would drop the
       * one message the client needed — which is exactly the shape of bug this helper
       * exists to find rather than create.
       */
      close: (): void => {
        queueMicrotask(() => {
          this.markClosed(false);
        });
      },
    };
  }

  get open(): boolean {
    return this.isOpen;
  }

  send(payload: unknown): void {
    if (!this.isOpen) {
      return;
    }
    this.server.deliver(this.roomCode, this.socket, JSON.stringify(payload));
  }

  onData(handler: (data: unknown) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onUnstable(handler: () => void): () => void {
    this.unstableHandlers.add(handler);
    return () => this.unstableHandlers.delete(handler);
  }

  probe(): void {
    // The runtime answers these without ever reaching the room, so an in-memory pipe
    // that is open by definition has nothing to prove.
  }

  close(): void {
    this.markClosed(true);
  }

  /** Test seam: the path degrades without closing. */
  degrade(): void {
    for (const handler of [...this.unstableHandlers]) {
      handler();
    }
  }

  private markClosed(tellTheRoom: boolean): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    if (tellTheRoom) {
      this.server.disconnect(this.roomCode, this.socket);
    }
    for (const handler of [...this.closeHandlers]) {
      handler();
    }
  }
}

export interface TestRoomOptions {
  readonly roomCode?: string;
  readonly startAt?: number;
  readonly seed?: number;
}

/**
 * Every room the test's clients reach, keyed by code, created on demand.
 *
 * A server rather than a single room, because the store picks its own six digits
 * when it opens one — the code is not the test's to choose. Rooms appear the first
 * time somebody dials them, exactly as a Durable Object does under `idFromName`.
 */
export class TestRoom {
  private clock: number;
  private readonly rooms = new Map<
    string,
    { room: GameRoom; alarms: ReturnType<typeof memoryAlarms>; store: RoomStore; channels: PipedChannel[] }
  >();

  constructor(private readonly options: TestRoomOptions = {}) {
    this.clock = options.startAt ?? 1_700_000_000_000;
    if (options.roomCode !== undefined) {
      this.at(options.roomCode);
    }
  }

  /** The room at this code, created if this is the first anybody has asked. */
  at(roomCode: string): GameRoom {
    return this.entry(roomCode).room;
  }

  private entry(roomCode: string): {
    room: GameRoom;
    alarms: ReturnType<typeof memoryAlarms>;
    store: RoomStore;
    channels: PipedChannel[];
  } {
    let entry = this.rooms.get(roomCode);
    if (entry === undefined) {
      const alarms = memoryAlarms();
      const store = memoryStore();
      entry = {
        alarms,
        store,
        channels: [],
        room: new GameRoom({
          roomCode,
          store,
          alarms: new AlarmMux(alarms, alarms),
          now: () => this.clock,
          seedFactory: () => this.options.seed ?? 4242,
          botPauseMs: () => 0,
          log: () => {},
        }),
      };
      this.rooms.set(roomCode, entry);
    }
    return entry;
  }

  /**
   * The single room, for tests that only ever open one.
   *
   * Throws rather than guessing when there is more than one, because "the room" is
   * then a question the test has to answer.
   */
  get room(): GameRoom {
    if (this.rooms.size !== 1) {
      throw new Error(`there are ${String(this.rooms.size)} rooms; name the one you mean with at()`);
    }
    return [...this.rooms.values()][0]!.room;
  }

  get store(): RoomStore {
    if (this.rooms.size !== 1) {
      throw new Error(`there are ${String(this.rooms.size)} rooms; name the one you mean`);
    }
    return [...this.rooms.values()][0]!.store;
  }

  /** Hand this to `ClientSession` as its `connect`. */
  get connect(): ChannelFactory {
    return (roomCode: string): Promise<RoomChannel> => {
      const entry = this.entry(roomCode);
      const channel = new PipedChannel(this, roomCode);
      entry.channels.push(channel);
      return Promise.resolve(channel);
    };
  }

  /**
   * Puts one player into a room without a session, so a code is already taken.
   *
   * Deliberately not a `ClientSession`: this is used from inside a channel factory,
   * where standing up a whole session would be a second connect racing the one being
   * answered. A bare socket and a hand-built frame is all "somebody is already here"
   * needs to mean.
   */
  seatSquatter(roomCode: string, name = 'someone'): void {
    const socket: RoomSocket = { send: () => {}, close: () => {} };
    this.entry(roomCode).room.handleMessage(
      socket,
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        id: `squat-${roomCode}`,
        roomId: roomCode,
        senderPeerId: 'squatter',
        timestamp: this.clock,
        type: 'joinRequest',
        payload: { displayName: name, create: { maxPlayers: 4, tableLanguage: 'he' } },
      }),
    );
  }

  /** Internal: a client sent a frame. */
  deliver(roomCode: string, socket: RoomSocket, raw: string): void {
    this.entry(roomCode).room.handleMessage(socket, raw);
  }

  /** Internal: a client's socket went away. */
  disconnect(roomCode: string, socket: RoomSocket): void {
    this.entry(roomCode).room.handleClose(socket);
  }

  now(): number {
    return this.clock;
  }

  /** Moves the clock, firing every alarm that comes due on the way, in every room. */
  advance(ms: number): void {
    const target = this.clock + ms;
    let guard = 0;
    for (;;) {
      let next: number | null = null;
      for (const entry of this.rooms.values()) {
        if (entry.alarms.armedAt !== null && (next === null || entry.alarms.armedAt < next)) {
          next = entry.alarms.armedAt;
        }
      }
      if (next === null || next > target) {
        break;
      }
      this.clock = Math.max(next, this.clock);
      for (const entry of this.rooms.values()) {
        if (entry.alarms.armedAt !== null && entry.alarms.armedAt <= this.clock) {
          entry.room.handleAlarm();
        }
      }
      if ((guard += 1) > 500) {
        throw new Error('a room kept re-arming its alarm');
      }
    }
    this.clock = target;
  }
}

/**
 * A room the test writes by hand.
 *
 * The counterpart to {@link TestRoom}, and needed for a different job. A real room
 * is the right thing to test *agreement* against — it will refuse what the real one
 * refuses. It is the wrong thing for testing how a client reacts to a particular
 * **arrival order**, or to a message a correct room would never send: the public
 * state, the hand and the event batch land as three separate frames, and the whole
 * point of some of these tests is what happens between the second and the third.
 *
 * So this end is scripted. `say()` puts an arbitrary room message on the wire, and
 * `received` is everything the client sent back.
 */
export class ScriptedRoom {
  readonly received: ClientMessage[] = [];
  private channels: ScriptedChannel[] = [];
  private idCounter = 0;

  constructor(readonly roomCode: string = TEST_ROOM) {}

  get connect(): ChannelFactory {
    return (): Promise<RoomChannel> => {
      const channel = new ScriptedChannel(this);
      this.channels.push(channel);
      return Promise.resolve(channel);
    };
  }

  /** Sends one room message to every live client. */
  say<TType extends RoomMessage['type']>(
    type: TType,
    payload: Extract<RoomMessage, { type: TType }>['payload'],
  ): void {
    this.idCounter += 1;
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      id: `m-${String(this.idCounter)}`,
      roomId: this.roomCode,
      senderPeerId: 'room',
      timestamp: 1_700_000_000_000,
      type,
      payload,
    };
    for (const channel of this.channels) {
      channel.deliver(message);
    }
  }

  /** Sends a raw value, however malformed, to test what a client refuses. */
  sayRaw(value: unknown): void {
    for (const channel of this.channels) {
      channel.deliver(value);
    }
  }

  /** Every message of a type the client has sent, oldest first. */
  all<TType extends ClientMessage['type']>(type: TType): Extract<ClientMessage, { type: TType }>[] {
    return this.received.filter((m): m is Extract<ClientMessage, { type: TType }> => m.type === type);
  }

  last<TType extends ClientMessage['type']>(
    type: TType,
  ): Extract<ClientMessage, { type: TType }> | undefined {
    return this.all(type).at(-1);
  }

  /** Drops every live socket, the way a lost network would. */
  dropAll(): void {
    for (const channel of [...this.channels]) {
      channel.dropSilently();
    }
    this.channels = [];
  }

  /** Reports the path as degraded without closing it. */
  degradeAll(): void {
    for (const channel of this.channels) {
      channel.degrade();
    }
  }
}

class ScriptedChannel implements RoomChannel {
  private dataHandlers = new Set<(data: unknown) => void>();
  private closeHandlers = new Set<() => void>();
  private unstableHandlers = new Set<() => void>();
  private isOpen = true;

  constructor(private readonly room: ScriptedRoom) {}

  get open(): boolean {
    return this.isOpen;
  }
  send(payload: unknown): void {
    if (this.isOpen) {
      this.room.received.push(payload as ClientMessage);
    }
  }
  onData(handler: (data: unknown) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }
  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
  onUnstable(handler: () => void): () => void {
    this.unstableHandlers.add(handler);
    return () => this.unstableHandlers.delete(handler);
  }
  probe(): void {}
  close(): void {
    this.dropSilently();
  }

  deliver(value: unknown): void {
    if (!this.isOpen) {
      return;
    }
    for (const handler of [...this.dataHandlers]) {
      handler(value);
    }
  }

  degrade(): void {
    for (const handler of [...this.unstableHandlers]) {
      handler();
    }
  }

  dropSilently(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    for (const handler of [...this.closeHandlers]) {
      handler();
    }
  }
}
