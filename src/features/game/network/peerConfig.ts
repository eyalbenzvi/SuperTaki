/**
 * Optional PeerJS configuration read from build-time environment variables.
 *
 * Everything here is optional: with no configuration the app uses the free
 * public PeerJS signalling service and free public STUN servers, which keeps
 * the third-party cost at exactly zero.
 *
 * To point the app at your own PeerServer later, set these when building:
 *   VITE_PEER_HOST, VITE_PEER_PORT, VITE_PEER_PATH, VITE_PEER_SECURE, VITE_PEER_KEY
 * To supply your own ICE servers (for example a self-hosted TURN server):
 *   VITE_ICE_SERVERS='[{"urls":"turn:example.org:3478","username":"u","credential":"c"}]'
 */

export interface PeerServerConfig {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly secure: boolean;
  readonly key?: string;
}

/**
 * Public STUN servers. STUN only helps peers discover its own address; it cannot
 * relay traffic.
 *
 * Two *different* providers on purpose: comparing the reflexive port each one
 * reports is how `probeConnectivity()` detects an address/port-dependent
 * ("symmetric") NAT, which no amount of STUN can traverse.
 */
export const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * The relays PeerJS already ships with, restated here so we can *merge* them.
 *
 * PeerJS's own `DEFAULT_CONFIG` carries these two community TURN servers, and
 * passing a `config` object to the `Peer` constructor **replaces** that default
 * wholesale rather than extending it. This app did exactly that, and so spent its
 * whole life throwing away the relay candidates it was already entitled to —
 * which is why `docs/architecture.md` described "no TURN, so some networks cannot
 * connect at all" as an immovable constraint. It was self-inflicted.
 *
 * What this is and is not: a donated, best-effort, community-run relay — the same
 * posture the project already accepts for the public signalling broker — offered
 * over UDP/3478 only. There is no `turns:`/443 entry, so a network that blocks
 * outbound UDP entirely still cannot connect, and a relay of our own would cost
 * money. Relay is also only ever a last resort: `iceTransportPolicy` stays at its
 * default, so a direct path always wins when one exists, and only genuinely
 * unreachable pairs consume donated bandwidth. A card game's traffic is a few
 * hundred bytes a move, which is why this is a defensible use of it.
 */
export const BUNDLED_TURN_SERVERS: RTCIceServer[] = [
  {
    urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
    username: 'peerjs',
    credential: 'peerjsp',
  },
];

/** STUN plus the bundled relays: the default ICE configuration. */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [...DEFAULT_STUN_SERVERS, ...BUNDLED_TURN_SERVERS];

function readEnv(name: string): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return value && value.length > 0 ? value : undefined;
}

export function readPeerServerConfig(): PeerServerConfig | null {
  const host = readEnv('VITE_PEER_HOST');
  if (!host) {
    return null;
  }
  const secure = readEnv('VITE_PEER_SECURE') !== 'false';
  const port = Number(readEnv('VITE_PEER_PORT') ?? (secure ? 443 : 9000));
  const key = readEnv('VITE_PEER_KEY');
  return {
    host,
    port: Number.isFinite(port) ? port : 443,
    path: readEnv('VITE_PEER_PATH') ?? '/',
    secure,
    ...(key ? { key } : {}),
  };
}

/**
 * ICE servers to use.
 *
 * A configured `VITE_ICE_SERVERS` is *added to* the defaults rather than
 * replacing them: someone supplying their own TURN server wants it in addition to
 * the free ones, not instead of them, and silently dropping the bundled relays is
 * the mistake this whole module now exists to avoid.
 */
export function readIceServers(): RTCIceServer[] {
  const raw = readEnv('VITE_ICE_SERVERS');
  if (!raw) {
    return DEFAULT_ICE_SERVERS;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return [...(parsed as RTCIceServer[]), ...DEFAULT_ICE_SERVERS];
    }
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_ICE_SERVERS;
}

/** WebRTC support probe used to show an actionable message on old browsers. */
export function isWebRtcSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.RTCPeerConnection === 'function';
}
