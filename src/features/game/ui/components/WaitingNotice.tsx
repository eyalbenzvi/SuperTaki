import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../../../components/Button.tsx';
import { Callout } from '../../../../components/Callout.tsx';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';
import {
  absentPlayers,
  amCreator,
  playerName,
  standInEnabled,
  standInPlayers,
  waitingFor,
} from '../../state/selectors.ts';

/** `4:07`, or `0:09`. */
function formatDuration(ms: number): string {
  const total = Math.max(Math.ceil(ms / 1000), 0);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

interface SeatHoldProps {
  readonly name: string;
  /** Milliseconds already elapsed when the creator built the snapshot. */
  readonly elapsedWhenSent: number;
  readonly graceMs: number;
  readonly actions: ReactNode;
}

/**
 * One held seat, counting down.
 *
 * The arithmetic spans two clocks and neither is read while rendering. The creator
 * tells us how long the seat had already been absent when it built the snapshot —
 * both of its readings are on its own clock, so the skew between the two devices
 * cancels — and everything after that is local elapsed time, counted by a ticking
 * integer rather than by asking what time it is.
 *
 * The creator's figure is taken **once**, when the callout appears, and the count
 * carries on locally from there. Two rejected alternatives are the reason:
 * re-keying on the snapshot tore the whole callout down several times a minute —
 * the creator re-broadcasts on every accepted command — which dropped keyboard focus
 * to the document mid-interaction and re-announced the callout to a screen reader;
 * re-anchoring inside an effect is a state write during commit that re-renders
 * every seat for a number nobody can see change. What is given up is correction
 * for clock drift between two devices over the few minutes a seat is held, which
 * is far below the one-second resolution displayed. A seat that fills and empties
 * again unmounts this in between, so the next hold re-anchors naturally.
 */
function SeatHold({ name, elapsedWhenSent, graceMs, actions }: SeatHoldProps): ReactNode {
  const t = useT();
  const [anchorMs] = useState(elapsedWhenSent);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds((value) => value + 1);
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const remaining = Math.max(graceMs - (anchorMs + seconds * 1_000), 0);
  return (
    /*
     * Deliberately not a live region.
     *
     * `role="status"` here announced the whole body every time its text changed —
     * and its text changes once a second, so a screen reader read the seat out
     * sixty times a minute and buried every other event at the table. The arrival
     * of the hold is said once, through the app's single announcer, by the parent.
     * The countdown stays in the accessibility tree and readable on demand; it
     * just no longer speaks for itself.
     */
    <Callout tone="warning" icon="hourglass" title={t('absent.title', { name })} actions={actions}>
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

  const pausedBy = useAppStore((state) => state.pausedBy);
  const localPlayerId = useAppStore((state) => state.localPlayerId);
  const skipAbsentTurn = useAppStore((state) => state.skipAbsentTurn);
  const removeFromRound = useAppStore((state) => state.removeFromRound);
  const standInNow = useAppStore((state) => state.standInNow);
  const creator = useAppStore(amCreator);
  const stopStandIn = useAppStore((state) => state.stopStandIn);
  const announce = useAppStore((state) => state.announce);

  const absent = absentPlayers({ lobby });
  const standIns = standInPlayers({ lobby });
  const robotsAllowed = standInEnabled({ lobby });
  const waiting = waitingFor({ lobby });

  /*
   * Said once per change in *who* is being held, through the one announcer the app
   * has. The callouts themselves cannot carry this: their text is a countdown, and
   * a live region containing a countdown talks over everything else.
   */
  const absentKey = absent.map((player) => player.id).join(',');
  useEffect(() => {
    if (absentKey === '') {
      return;
    }
    announce(absent.map((player) => t('absent.title', { name: player.name })).join(' '));
    // The set of held seats is what makes this worth saying again; a new snapshot
    // for the same seats is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absentKey, announce]);

  if (pausedBy !== null) {
    const who = pausedBy === localPlayerId ? null : playerName({ publicState, lobby }, pausedBy);
    return (
      <Callout tone="info" icon="hourglass" title={t('pause.title')} role="status">
        {who === null ? t('pause.byYou') : t('pause.body', { name: who })}
      </Callout>
    );
  }

  if (absent.length === 0 && standIns.length === 0) {
    return null;
  }

  const graceMs = lobby?.seatGraceMs ?? 0;
  const sentAt = lobby?.sentAt;

  return (
    <>
      {/*
        A robot playing somebody's hand is stated plainly, to everybody. It is the
        one thing at this table that is not a person, and a table that could not tell
        would be being deceived by omission — so the seat keeps its owner's name and
        the notice says who is being covered for.
      */}
      {standIns.map((player) => (
        <Callout
          key={player.id}
          tone="info"
          icon="robot"
          title={t('robot.playingFor', { name: player.name })}
          role="status"
          actions={
            creator ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    stopStandIn(player.id);
                  }}
                >
                  {t('robot.standInStop')}
                </Button>
                {/*
                  A covered seat is not listed as held, so this is the only place the
                  table can still take an absent player out of the round. Without it,
                  a robot covering somebody whose phone is dead left the creator with the
                  abandon vote as their one way out.
                */}
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
          {t('robot.playingForBody')}
        </Callout>
      ))}

      {absent.map((player) => {
        const isWaitingOnThem = waiting?.playerId === player.id && waiting.reason === 'absent';
        return (
          <SeatHold
            key={player.id}
            name={player.name}
            elapsedWhenSent={sentAt !== undefined ? Math.max(sentAt - player.absentSince, 0) : 0}
            graceMs={graceMs}
            actions={
              creator && isWaitingOnThem ? (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      skipAbsentTurn(player.id);
                    }}
                  >
                    {t('absent.skipNow')}
                  </Button>
                  {/*
                    The impatient option, and the reason the automatic threshold can
                    afford to be slow: a table that does not want to wait another
                    thirty seconds says so here.
                  */}
                  {robotsAllowed ? (
                    <Button
                      variant="ghost"
                      icon="robot"
                      onClick={() => {
                        standInNow(player.id);
                      }}
                    >
                      {t('robot.standInNow')}
                    </Button>
                  ) : null}
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
