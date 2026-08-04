import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Callout } from '../../../../components/Callout.tsx';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';
import { absentPlayers, isHost, playerName, waitingFor } from '../../state/selectors.ts';

/** `4:07`, or `0:09`. */
function formatDuration(ms: number): string {
  const total = Math.max(Math.ceil(ms / 1000), 0);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

interface SeatHoldProps {
  readonly name: string;
  /** Milliseconds already elapsed when the host built the snapshot. */
  readonly elapsedWhenSent: number;
  readonly graceMs: number;
  readonly actions: ReactNode;
}

/**
 * One held seat, counting down.
 *
 * The arithmetic spans two clocks and neither is read while rendering. The host
 * tells us how long the seat had already been absent when it built the snapshot —
 * both of its readings are on its own clock, so the skew between the two devices
 * cancels — and everything after that is local elapsed time, counted by a ticking
 * integer rather than by asking what time it is.
 *
 * The caller keys this on the snapshot, so a fresh one restarts the count from the
 * host's new number instead of drifting away from it.
 */
function SeatHold({ name, elapsedWhenSent, graceMs, actions }: SeatHoldProps): ReactNode {
  const t = useT();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds((value) => value + 1);
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const remaining = Math.max(graceMs - (elapsedWhenSent + seconds * 1_000), 0);
  return (
    <Callout
      tone="warning"
      icon="hourglass"
      title={t('absent.title', { name })}
      role="status"
      actions={actions}
    >
      {t('absent.holdingSeat', { time: formatDuration(remaining) })}
    </Callout>
  );
}

/**
 * Who the table is waiting for, and for how long.
 *
 * This is the whole emotional difference the resilience work is for. Before it, a
 * player who lost their connection produced a flat "disconnected" badge and,
 * sooner or later, a game that had ended; now the table says "we're holding Noa's
 * seat, 2:41" and carries on playing round her.
 */
export function WaitingNotice(): ReactNode {
  const t = useT();
  const lobby = useAppStore((state) => state.lobby);
  const publicState = useAppStore((state) => state.publicState);
  const role = useAppStore((state) => state.role);
  const pausedBy = useAppStore((state) => state.pausedBy);
  const localPlayerId = useAppStore((state) => state.localPlayerId);
  const skipAbsentTurn = useAppStore((state) => state.skipAbsentTurn);
  const removeFromRound = useAppStore((state) => state.removeFromRound);

  const absent = absentPlayers({ lobby });
  const waiting = waitingFor({ lobby });

  if (pausedBy !== null) {
    const who = pausedBy === localPlayerId ? null : playerName({ publicState, lobby }, pausedBy);
    return (
      <Callout tone="info" icon="hourglass" title={t('pause.title')} role="status">
        {who === null ? t('pause.byYou') : t('pause.body', { name: who })}
      </Callout>
    );
  }

  if (absent.length === 0) {
    return null;
  }

  const host = isHost({ role });
  const graceMs = lobby?.seatGraceMs ?? 0;
  const sentAt = lobby?.sentAt;

  return (
    <>
      {absent.map((player) => {
        const isWaitingOnThem = waiting?.playerId === player.id && waiting.reason === 'absent';
        return (
          <SeatHold
            // Re-anchored on every snapshot, so the local count never drifts from
            // the host's own measurement of the same absence.
            key={`${player.id}:${String(sentAt ?? 0)}`}
            name={player.name}
            elapsedWhenSent={sentAt !== undefined ? Math.max(sentAt - player.absentSince, 0) : 0}
            graceMs={graceMs}
            actions={
              host && isWaitingOnThem ? (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      skipAbsentTurn(player.id);
                    }}
                  >
                    {t('absent.skipNow')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      removeFromRound(player.id);
                    }}
                  >
                    {t('absent.removeFromRound')}
                  </Button>
                </>
              ) : null
            }
          />
        );
      })}
    </>
  );
}
