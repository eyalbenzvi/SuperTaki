/**
 * Where the relay lives.
 *
 * Production builds set `VITE_RELAY_URL` (the Pages workflow passes the
 * `RELAY_URL` repository variable through). Local development falls back to a
 * `wrangler dev` instance on the conventional port, so `npm run dev` plus
 * `npm run dev` inside `worker/` is a complete offline multiplayer setup.
 */

const DEV_RELAY_URL = 'ws://127.0.0.1:8787';

function readEnv(name: string): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return value && value.length > 0 ? value : undefined;
}

/** Base relay URL (`ws://` or `wss://`), without a path. */
export function relayBaseUrl(): string {
  const configured = readEnv('VITE_RELAY_URL');
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  return import.meta.env.DEV ? DEV_RELAY_URL : '';
}

/** Full WebSocket URL for a room, or `null` when no relay is configured. */
export function relayRoomUrl(roomCode: string): string | null {
  const base = relayBaseUrl();
  if (base.length === 0) {
    return null;
  }
  return `${base}/v1/room/${roomCode}`;
}
