/**
 * The Durable Object adapter around `GameRoom`.
 *
 * One instance exists per room code (`idFromName(code)`), so every player in a room
 * reaches the same object wherever they connect from, and that object holds the
 * game. The class keeps doing what it did when this was a relay — accept sockets,
 * hand frames to a core, survive hibernation — and the core it hands them to is now
 * the authority rather than a router.
 *
 * The object uses the WebSocket Hibernation API: between messages it is evicted
 * from memory and costs nothing, while its sockets stay open and `ping`/`pong`
 * liveness traffic is answered by the runtime without ever waking it. That is the
 * whole zero-cost story, and it is why the room's deadlines are alarms rather than
 * a heartbeat — see `alarms.ts`.
 *
 * State lives in two places, by lifetime:
 * - Live sockets are reconstructed after a wake from each socket's serialized
 *   attachment (the seat it proved it owns).
 * - Everything else — seats, credentials, the deck, every hand — lives in the
 *   object's SQLite storage, which is what lets any player, including whoever
 *   opened the room, vanish for an hour and come back to the table they left.
 */

import { AlarmMux, type AlarmPlatform, type AlarmStore } from './alarms.ts';
import { PROBE_REQUEST, PROBE_RESPONSE } from './protocol.ts';
import { GameRoom, type RoomSocket } from './gameRoom.ts';
import type { RoomStore } from './storage.ts';

interface Attachment {
  readonly playerId?: string;
}

/** The room record and the game state, over the object's SQLite storage. */
class SqlRoomStore implements RoomStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }

  get(key: string): string | undefined {
    const row = this.sql.exec('SELECT v FROM kv WHERE k = ?', key).toArray()[0];
    return row === undefined ? undefined : (row['v'] as string);
  }

  put(key: string, value: string): void {
    this.sql.exec(
      'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      key,
      value,
    );
  }

  delete(key: string): void {
    this.sql.exec('DELETE FROM kv WHERE k = ?', key);
  }
}

/** The alarm queue, over the same storage. One row per pending deadline. */
class SqlAlarmStore implements AlarmStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS alarms (kind TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  }

  entries(): { kind: string; at: number }[] {
    return this.sql
      .exec('SELECT kind, at FROM alarms')
      .toArray()
      .map((row) => ({ kind: row['kind'] as string, at: Number(row['at']) }));
  }

  put(kind: string, at: number): void {
    this.sql.exec(
      'INSERT INTO alarms (kind, at) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET at = excluded.at',
      kind,
      at,
    );
  }

  delete(kind: string): void {
    this.sql.exec('DELETE FROM alarms WHERE kind = ?', kind);
  }
}

export class RoomDO implements DurableObject {
  private room: GameRoom | null = null;
  /** Stable wrapper per runtime socket, so `GameRoom`'s maps keep their keys. */
  private readonly wrappers = new WeakMap<WebSocket, RoomSocket>();

  constructor(private readonly ctx: DurableObjectState) {
    // Answered by the runtime while the object sleeps; the client uses it to detect a
    // half-open TCP connection after a phone wakes up. It never reaches the game, and
    // never wakes this object — see `PROBE_REQUEST`.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PROBE_REQUEST, PROBE_RESPONSE));
  }

  fetch(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private wrap(ws: WebSocket): RoomSocket {
    let wrapper = this.wrappers.get(ws);
    if (wrapper === undefined) {
      wrapper = {
        send(data: string): void {
          try {
            ws.send(data);
          } catch {
            /* the runtime will follow with a close event; nothing to do */
          }
        },
        close(code: number, reason: string): void {
          try {
            ws.close(code, reason);
          } catch {
            /* already closing */
          }
        },
      };
      this.wrappers.set(ws, wrapper);
    }
    return wrapper;
  }

  /** Rebuilds the in-memory picture after a hibernation wake. */
  private ensureRoom(): GameRoom {
    if (this.room !== null) {
      return this.room;
    }
    const sql = this.ctx.storage.sql;
    const alarmStore = new SqlAlarmStore(sql);
    const platform: AlarmPlatform = {
      setAlarm: (atMs) => {
        void this.ctx.storage.setAlarm(atMs);
      },
      deleteAlarm: () => {
        void this.ctx.storage.deleteAlarm();
      },
    };

    /*
     * Every socket the runtime still holds, with the seat it proved it owns. Handing
     * them to the constructor rather than attaching them afterwards matters: the room
     * reconciles persisted absence against the sockets that actually survived, and it
     * can only do that once it knows about all of them.
     */
    const restore: { socket: RoomSocket; playerId: string }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.playerId !== undefined) {
        restore.push({ socket: this.wrap(ws), playerId: attachment.playerId });
      }
    }

    this.room = new GameRoom({
      roomCode: this.ctx.id.name ?? '',
      store: new SqlRoomStore(sql),
      alarms: new AlarmMux(alarmStore, platform),
      restore,
      log: (message, detail) => {
        console.log(`[room] ${message}`, detail ?? '');
      },
    });
    return this.room;
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    if (typeof message !== 'string') {
      ws.close(4000, 'text frames only');
      return;
    }
    const room = this.ensureRoom();
    const wrapper = this.wrap(ws);
    const before = room.identityOf(wrapper);
    room.handleMessage(wrapper, message);
    const after = room.identityOf(wrapper);
    if (after !== before && after !== null) {
      // Written when the join is accepted: this is what survives hibernation and lets
      // `ensureRoom` re-bind the socket to its seat.
      ws.serializeAttachment({ playerId: after } satisfies Attachment);
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.ensureRoom().handleClose(this.wrap(ws));
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const room = this.ensureRoom();
    if (room.handleAlarm()) {
      // The room asked to be forgotten: nobody has been here for the whole idle TTL.
      // Deleting storage is the platform's business, which is why the room reports
      // rather than acts.
      await this.ctx.storage.deleteAll();
      this.room = null;
    }
  }
}
