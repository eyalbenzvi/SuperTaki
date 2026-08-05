/**
 * The Durable Object adapter around `RoomCore`.
 *
 * One instance exists per room code (`idFromName(code)`), so every player in a
 * room reaches the same object wherever they connect from. The object uses the
 * WebSocket Hibernation API: between messages it is evicted from memory and
 * costs nothing, while its sockets stay open — `ping`/`pong` liveness traffic is
 * answered by the runtime without ever waking it.
 *
 * State lives in two places, by lifetime:
 * - Live peers are reconstructed after a wake from each socket's serialized
 *   attachment (its authenticated peer id).
 * - Claims (who owns which peer id) live in the object's SQLite storage, which
 *   is what lets a host reclaim its room code after its old socket, and even
 *   this object's memory, are long gone.
 */

import { ROOM_IDLE_TTL_MS } from './protocol.ts';
import { RoomCore, type ClaimRecord, type ClaimStore, type PeerSocket } from './roomCore.ts';

interface Attachment {
  readonly peerId?: string;
}

/** Synchronous claim persistence over the object's SQLite storage. */
class SqlClaimStore implements ClaimStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS claims (peer_id TEXT PRIMARY KEY, claim TEXT NOT NULL, last_seen INTEGER NOT NULL)',
    );
  }

  get(peerId: string): ClaimRecord | undefined {
    const row = this.sql.exec('SELECT claim, last_seen FROM claims WHERE peer_id = ?', peerId).toArray()[0];
    if (row === undefined) {
      return undefined;
    }
    return { claim: row['claim'] as string, lastSeen: Number(row['last_seen']) };
  }

  put(peerId: string, record: ClaimRecord): void {
    this.sql.exec(
      'INSERT INTO claims (peer_id, claim, last_seen) VALUES (?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET claim = excluded.claim, last_seen = excluded.last_seen',
      peerId,
      record.claim,
      record.lastSeen,
    );
  }
}

export class RoomDO implements DurableObject {
  private core: RoomCore | null = null;
  /** Stable wrapper per runtime socket, so `RoomCore`'s maps keep their keys. */
  private readonly wrappers = new WeakMap<WebSocket, PeerSocket>();

  constructor(private readonly ctx: DurableObjectState) {
    // Answered by the runtime while the object sleeps; the client uses it to
    // detect a half-open TCP connection after a phone wakes up.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  fetch(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    // A socket that never completes a hello should not pin the room alive.
    void this.ctx.storage.deleteAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private wrap(ws: WebSocket): PeerSocket {
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
  private ensureCore(): RoomCore {
    if (this.core !== null) {
      return this.core;
    }
    const core = new RoomCore(new SqlClaimStore(this.ctx.storage.sql));
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.peerId !== undefined) {
        core.restore(this.wrap(ws), attachment.peerId);
      }
    }
    this.core = core;
    return core;
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    if (typeof message !== 'string') {
      ws.close(4000, 'text frames only');
      return;
    }
    const core = this.ensureCore();
    const wrapper = this.wrap(ws);
    const hadIdentity = core.identityOf(wrapper) !== undefined;
    core.handleMessage(wrapper, message);
    if (!hadIdentity) {
      const peerId = core.identityOf(wrapper);
      if (peerId !== undefined) {
        // Written once, after the hello is accepted: this is what survives
        // hibernation and lets `ensureCore` re-identify the socket.
        ws.serializeAttachment({ peerId } satisfies Attachment);
        void this.ctx.storage.deleteAlarm();
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    const core = this.ensureCore();
    core.handleClose(this.wrap(ws));
    if (core.peerIds().length === 0) {
      // Empty room: schedule the forgetting. A returning player cancels it by
      // saying hello; the alarm firing means nobody did for the whole TTL.
      void this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_TTL_MS);
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.core = null;
    }
  }
}
