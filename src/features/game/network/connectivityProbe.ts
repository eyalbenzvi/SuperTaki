import { record } from '../../../lib/diagnostics.ts';
import { createLogger } from '../../../lib/logger.ts';
import { BUNDLED_TURN_SERVERS, DEFAULT_STUN_SERVERS, isWebRtcSupported } from './peerConfig.ts';
import { CONNECTIVITY_PROBE_MS } from './timing.ts';

const log = createLogger('probe');

/**
 * Diagnoses this network *before* a room exists.
 *
 * No broker, no peer, no room code: one local `RTCPeerConnection` gathering its
 * own candidates tells us almost everything worth knowing, in about a second and
 * for nothing.
 *
 * - No server-reflexive candidate at all means outbound UDP (and therefore STUN)
 *   is blocked, so a direct connection cannot happen here.
 * - A reflexive candidate but no relay candidate means the free relays are
 *   unreachable, so an unreachable pair has no fallback.
 * - Two *different* STUN servers reporting two *different* reflexive ports means
 *   an address/port-dependent — "symmetric" — NAT, which no amount of STUN can
 *   traverse. `docs/architecture.md` treated that as undetectable; it is one
 *   comparison.
 *
 * The point is to replace a spinner that never resolves with a straight answer
 * given up front, and to offer the one-device mode when the answer is bad.
 */

export type ConnectivityVerdict =
  /** Direct connections should work. */
  | 'direct'
  /** Direct connections will probably fail, but a relay is available. */
  | 'relayNeeded'
  /** Neither a direct path nor a relay could be found: peer-to-peer will not work. */
  | 'blocked'
  /** The probe could not run (no WebRTC, or the browser refused). */
  | 'unknown';

export interface ConnectivityReport {
  readonly verdict: ConnectivityVerdict;
  /** Candidate types gathered, e.g. `['host', 'srflx', 'relay']`. */
  readonly candidateTypes: readonly string[];
  /** True when two STUN servers disagreed about our reflexive port. */
  readonly symmetricNat: boolean;
  /** Distinct reflexive `address:port` pairs seen, for the diagnostics log. */
  readonly reflexive: readonly string[];
  readonly durationMs: number;
}

interface ParsedCandidate {
  readonly type: string;
  readonly address: string;
  readonly port: string;
}

/**
 * Pulls the fields we need out of a candidate line.
 *
 * `RTCIceCandidate.type`/`.address` are not populated in every browser, so the
 * SDP attribute is parsed directly: it is the one representation everybody agrees
 * on. Shape: `candidate:<foundation> <component> <transport> <priority>
 * <address> <port> typ <type> ...`
 */
function parseCandidate(candidate: string): ParsedCandidate | null {
  const parts = candidate.replace(/^candidate:/, '').split(/\s+/);
  if (parts.length < 8) {
    return null;
  }
  const address = parts[4];
  const port = parts[5];
  const typeIndex = parts.indexOf('typ');
  const type = typeIndex >= 0 ? parts[typeIndex + 1] : undefined;
  if (!address || !port || !type) {
    return null;
  }
  return { type, address, port };
}

/**
 * Runs one gathering pass and reports what came back.
 *
 * Both STUN servers and both relays are offered at once. Comparing the reflexive
 * *ports* across servers is what detects a symmetric NAT, so more than one STUN
 * server is not redundancy here — it is the measurement.
 */
export async function probeConnectivity(timeoutMs = CONNECTIVITY_PROBE_MS): Promise<ConnectivityReport> {
  const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
  const elapsed = (): number =>
    Math.round((typeof performance === 'undefined' ? Date.now() : performance.now()) - startedAt);

  if (!isWebRtcSupported()) {
    return {
      verdict: 'unknown',
      candidateTypes: [],
      symmetricNat: false,
      reflexive: [],
      durationMs: elapsed(),
    };
  }

  let connection: RTCPeerConnection | null = null;
  const types = new Set<string>();
  const reflexive = new Set<string>();

  try {
    connection = new RTCPeerConnection({
      iceServers: [...DEFAULT_STUN_SERVERS, ...BUNDLED_TURN_SERVERS],
    });
    // A data channel is what makes the browser gather candidates at all.
    connection.createDataChannel('probe');

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const peer = connection as RTCPeerConnection;
      peer.onicecandidate = (event) => {
        if (!event.candidate) {
          // Null candidate means gathering finished on its own.
          finish();
          return;
        }
        const parsed = parseCandidate(event.candidate.candidate);
        if (!parsed) {
          return;
        }
        types.add(parsed.type);
        if (parsed.type === 'srflx') {
          reflexive.add(`${parsed.address}:${parsed.port}`);
        }
        // Once a relay candidate exists the verdict cannot get worse, so there is
        // no reason to keep a probe running in front of a waiting player.
        if (parsed.type === 'relay') {
          finish();
        }
      };
      void peer
        .createOffer()
        .then((offer) => peer.setLocalDescription(offer))
        .catch((error: unknown) => {
          log.warn('probe offer failed', error);
          finish();
        });
    });
  } catch (error) {
    log.warn('probe failed', error);
    const report: ConnectivityReport = {
      verdict: 'unknown',
      candidateTypes: [...types],
      symmetricNat: false,
      reflexive: [...reflexive],
      durationMs: elapsed(),
    };
    record('connectivityProbe', 'probe failed', { verdict: report.verdict });
    return report;
  } finally {
    try {
      connection?.close();
    } catch {
      /* ignore */
    }
  }

  const ports = new Set([...reflexive].map((entry) => entry.split(':')[1] ?? ''));
  const symmetricNat = ports.size > 1;
  const hasReflexive = types.has('srflx');
  const hasRelay = types.has('relay');

  const verdict: ConnectivityVerdict = hasRelay
    ? symmetricNat || !hasReflexive
      ? 'relayNeeded'
      : 'direct'
    : hasReflexive
      ? symmetricNat
        ? 'blocked'
        : 'direct'
      : 'blocked';

  const report: ConnectivityReport = {
    verdict,
    candidateTypes: [...types],
    symmetricNat,
    reflexive: [...reflexive],
    durationMs: elapsed(),
  };
  record('connectivityProbe', verdict, {
    types: [...types].join(','),
    symmetricNat,
    reflexiveCount: reflexive.size,
    durationMs: report.durationMs,
  });
  return report;
}

/**
 * Whether the device can reach the internet at all, as opposed to merely having
 * an interface up.
 *
 * `navigator.onLine` is true for a WiFi network with no route and true behind a
 * captive portal — that is, true in exactly the situations where nothing works —
 * and it flaps during a network handover. A same-origin request is the honest
 * test, it needs nothing but the bytes the site already serves, and the existing
 * `connect-src 'self'` covers it.
 */
export async function probeReachability(timeoutMs = 3_000): Promise<boolean> {
  if (typeof fetch !== 'function' || typeof window === 'undefined') {
    return true;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const url = new URL(window.location.href);
    url.hash = '';
    url.search = `probe=${Date.now()}`;
    await fetch(url.toString(), { method: 'HEAD', cache: 'no-store', signal: controller.signal });
    record('reachability', 'origin reachable');
    return true;
  } catch {
    record('reachability', 'origin unreachable');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
