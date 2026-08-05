/**
 * The Worker in front of the rooms.
 *
 * Its whole job is routing: `/v1/room/<six digits>` upgrades to a WebSocket and
 * lands on the Durable Object named by that room code. Everything interesting
 * happens in `room.ts`.
 */

import { ROOM_CODE_PATTERN } from './protocol.ts';

export { RoomDO } from './room.ts';

export interface Env {
  readonly ROOM: DurableObjectNamespace;
  /**
   * Optional comma-separated Origin allowlist (e.g. the GitHub Pages origin).
   * Unset means any origin may connect — acceptable for a relay that carries
   * no secrets and lets peers, not the server, authenticate each other.
   */
  readonly ALLOWED_ORIGINS?: string;
}

const ROOM_PATH = /^\/v1\/room\/(\d{6})$/;

function originAllowed(request: Request, env: Env): boolean {
  if (env.ALLOWED_ORIGINS === undefined || env.ALLOWED_ORIGINS.length === 0) {
    return true;
  }
  const origin = request.headers.get('Origin');
  if (origin === null) {
    return false;
  }
  return env.ALLOWED_ORIGINS.split(',').some((allowed) => allowed.trim() === origin);
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    const match = ROOM_PATH.exec(url.pathname);
    if (match === null) {
      return new Response('not found', { status: 404 });
    }
    const code = match[1] as string;
    if (!ROOM_CODE_PATTERN.test(code)) {
      return new Response('bad room code', { status: 400 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    if (!originAllowed(request, env)) {
      return new Response('origin not allowed', { status: 403 });
    }

    const room = env.ROOM.get(env.ROOM.idFromName(code));
    return room.fetch(request);
  },
} satisfies ExportedHandler<Env>;
