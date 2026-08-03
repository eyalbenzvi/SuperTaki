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
 * Public STUN servers. STUN only helps peers discover their own address; it
 * cannot relay traffic, so symmetric NATs still fail (see docs/architecture.md).
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

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

export function readIceServers(): RTCIceServer[] {
  const raw = readEnv('VITE_ICE_SERVERS');
  if (!raw) {
    return DEFAULT_ICE_SERVERS;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as RTCIceServer[];
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
