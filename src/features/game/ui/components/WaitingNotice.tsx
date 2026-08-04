import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Callout } from '../../../../components/Callout.tsx';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';
import { absentPlayers, isHost, playerName, seatHoldRemainingMs, waitingFor } from '../../state/selectors.ts';

/** `4:07`, or `0:09`. */
function formatDuration(ms: number): string {
  const total = Math.max(Math.ceil(ms / 1000), 0);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Who the table is waiting for, and for how long.
 *
 * This is the whole emotional difference the resilience work is for. Before it, a
 * player who lost their connection produced a flat "disconnected" badge and,
 * sooner or later, a game that had ended; now the table says "we're holding Noa's
 * seat, 2:41" and carries on playing round her. The countdown is rendered locally
 * from a single absolute timestamp the host sends, so it costs no traffic and
 * cannot drift against the host's own clock.
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
  const [, setTick] = useState(0);

  const absent = absentPlayers({ lobby });
  const waiting = waitingFor({ lobby });

  // One second is the right cadence for a countdown and the wrong one for
  // anything else, so it only runs while there is actually a countdown on screen.
  useEffect(() => {
    if (absent.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      setTick((value) => value + 1);
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [absent.length]);

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
  return (
    <>
      {absent.map((player) => {
        const remaining = seatHoldRemainingMs({ lobby }, player.absentSince);
        const isWaitingOnThem = waiting?.playerId === player.id && waiting.reason === 'absent';
        return (
          <Callout
            key={player.id}
            tone="warning"
            icon="hourglass"
            title={t('absent.title', { name: player.name })}
            role="status"
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
          >
            {t('absent.holdingSeat', { time: formatDuration(remaining) })}
          </Callout>
        );
      })}
    </>
  );
}
