import { useEffect, useState, type ReactNode } from 'react';
import { Callout } from '../../../../components/Callout.tsx';
import { useT } from '../../../../app/useT.ts';
import { probeConnectivity, type ConnectivityReport } from '../../network/connectivityProbe.ts';
import { useAppStore } from '../../state/store.ts';

/** Connection failures that are worth diagnosing rather than just reporting. */
const WORTH_PROBING = new Set(['peerUnavailable', 'network', 'timeout', 'unknown']);

/**
 * Says what is actually wrong with this network, once a connection has failed.
 *
 * The failure a player used to get was "the direct connection between players
 * failed", which is true and useless: it does not distinguish a network that
 * cannot make a path from a room code that was mistyped. One local
 * `RTCPeerConnection` — no broker, no peer, no room — answers that in about a
 * second by looking at which kinds of ICE candidate it can gather, and comparing
 * the reflexive port two different STUN servers report even detects the
 * address-dependent NAT that no amount of STUN can traverse.
 *
 * It runs only after something has already gone wrong. Probing speculatively
 * would spend a second of everybody's time to tell almost everybody nothing.
 */
export function ConnectivityNotice(): ReactNode {
  const t = useT();
  const phase = useAppStore((state) => state.phase);
  const error = useAppStore((state) => state.error);
  const online = useAppStore((state) => state.online);
  const [report, setReport] = useState<ConnectivityReport | null>(null);

  const shouldProbe =
    online && phase === 'failed' && error !== null && WORTH_PROBING.has(error.code) && report === null;

  useEffect(() => {
    if (!shouldProbe) {
      return;
    }
    let cancelled = false;
    void probeConnectivity().then((result) => {
      if (!cancelled) {
        setReport(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [shouldProbe]);

  if (report === null) {
    return null;
  }

  const tone = report.verdict === 'direct' ? 'info' : report.verdict === 'blocked' ? 'warning' : 'info';

  return (
    <Callout tone={tone} icon="info" title={t('probe.title')} role="status">
      {t(`probe.${report.verdict}`)}
    </Callout>
  );
}
