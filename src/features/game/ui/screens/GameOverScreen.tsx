import type { ReactNode } from 'react';
import { Badge } from '../../../../components/Badge.tsx';
import { Button } from '../../../../components/Button.tsx';
import { Icon } from '../../../../components/Icon.tsx';
import { useT } from '../../../../app/useT.ts';
import { STAIRS_STAGES } from '../../engine/cards.ts';
import {
  robotSeat,
  roundGameMode,
  scoreboard,
  standings,
  wasAbandoned,
  winnerName,
} from '../../state/selectors.ts';
import { useAppStore } from '../../state/store.ts';
import { ConnectionPhaseNotice } from '../components/ConnectionPhaseNotice.tsx';

/**
 * The end of a round.
 *
 * The result is the screen, not a line of text above a table: who won is stated
 * once, large, and marked in the standings by a word as well as by a tint. Below
 * it, the only two things left to decide — another round, or out.
 */
export function GameOverScreen(): ReactNode {
  const t = useT();
  const state = useAppStore();
  const rows = standings(state);
  const scores = scoreboard(state);
  const stairs = roundGameMode(state) === 'stairs';
  const winner = state.publicState?.winnerId ?? null;
  const abandoned = wasAbandoned(state);
  const iWon = winner !== null && winner === state.localPlayerId;
  const agreed = state.playAgain?.agreed ?? [];
  const required = state.playAgain?.required ?? 0;
  const mySeat = state.lobby?.players.find((player) => player.id === state.localPlayerId);
  /*
   * A robot covering your seat agrees to play again on your behalf — a table with one
   * could never deal a second round otherwise. That agreement is not yours, though,
   * so the button must not come up already pressed: your first tap means yes, not
   * "actually, no".
   */
  const iAgreed =
    state.localPlayerId !== null && agreed.includes(state.localPlayerId) && mySeat?.standIn !== true;

  return (
    <div className="page">
      <ConnectionPhaseNotice />

      {/*
       * A round that ran out of players, or that the table agreed to stop, has no
       * winner — and saying so plainly is the point. Naming one anyway would be a
       * lie, and leaving the line blank would read as a bug.
       */}
      <div className={`result ${iWon && !abandoned ? 'result--mine' : ''}`.trim()}>
        <span className="result__icon" aria-hidden="true">
          <Icon name={abandoned ? 'info' : 'trophy'} size={2.4} />
        </span>
        <h1 className="result__title">{t('over.title')}</h1>
        <p className="result__winner">
          {abandoned
            ? t('abandon.abandoned')
            : iWon
              ? t('over.winnerYou')
              : t('over.winner', { name: winnerName(state) ?? '—' })}
        </p>
      </div>

      <section className="panel">
        <h2 className="panel__title">{t('over.standings')}</h2>
        <table className="standings">
          <thead>
            <tr>
              <th scope="col">{t('over.rank')}</th>
              <th scope="col">{t('over.player')}</th>
              {/* Only where it means something. In a stairs round it is the result
                  and the cards left are the detail; in a classic one there is no
                  staircase to report. */}
              {stairs ? <th scope="col">{t('over.stairsStep')}</th> : null}
              <th scope="col">{t('over.cardsLeft')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.playerId} className={row.playerId === winner ? 'standings__winner' : undefined}>
                <td>{row.rank}</td>
                <td>
                  <span className="cluster">
                    <span className="truncate">{row.name}</span>
                    {row.playerId === state.localPlayerId ? (
                      <span className="text-small muted">({t('common.you')})</span>
                    ) : null}
                    {/* A tinted row is invisible to a player who cannot see the
                        tint, so the winner is also named. */}
                    {row.playerId === winner ? (
                      <Badge tone="success" icon="trophy">
                        {t('over.winnerBadge')}
                      </Badge>
                    ) : null}
                    {/* Who was a robot, and whose hand one played, belongs in the
                        result: a round decided partly by a robot reads differently
                        from one that was not, and the table should not have to
                        remember. */}
                    {robotSeat(state, row.playerId) ? <Badge icon="robot">{t('robot.badge')}</Badge> : null}
                  </span>
                </td>
                {stairs ? (
                  <td className="standings__count">
                    {t('over.stairsStepValue', {
                      done: row.stairsStep ?? 0,
                      total: STAIRS_STAGES,
                    })}
                  </td>
                ) : null}
                {/* The column header carries the unit; repeating it in every
                    cell just makes the table harder to scan. */}
                <td className="standings__count">{row.cardCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/*
       * The evening, next to the round.
       *
       * Only once somebody has actually won something: a column of noughts after the
       * first round would be a scoreboard that says nothing, and it would push the
       * two decisions this screen exists for further down the page. Wins only — no
       * points for the cards anybody was left holding — so a round lost by one card
       * and a round lost by twelve cost exactly the same, which is what "we are
       * playing best of five" already means to a table.
       */}
      {scores.length > 0 ? (
        <section className="panel">
          <h2 className="panel__title">{t('over.scoreTitle')}</h2>
          {/* Same table styling, its own name: two tables of the same shape on one
              screen otherwise leave "the standings" ambiguous to a stylesheet and to
              anything selecting a row — which is exactly how the end-to-end test
              that counts empty hands started counting wins as well. */}
          <table className="standings standings--score">
            <thead>
              <tr>
                <th scope="col">{t('over.rank')}</th>
                <th scope="col">{t('over.player')}</th>
                <th scope="col">{t('over.wins')}</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((row) => (
                <tr key={row.playerId}>
                  <td>{row.rank}</td>
                  <td>
                    <span className="cluster">
                      <span className="truncate">{row.name}</span>
                      {row.playerId === state.localPlayerId ? (
                        <span className="text-small muted">({t('common.you')})</span>
                      ) : null}
                    </span>
                  </td>
                  <td className="standings__count">{row.wins}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* The one thing about the score worth promising, said where the score is. */}
          <p className="text-small muted">{t('over.scoreHint')}</p>
        </section>
      ) : null}

      <div className="action-bar">
        <Button
          variant="primary"
          size="lg"
          block
          icon={iAgreed ? 'hourglass' : 'clockwise'}
          aria-pressed={iAgreed}
          onClick={() => {
            state.votePlayAgain(!iAgreed);
          }}
        >
          {t('over.playAgain')}
        </Button>
        {/* Leaving here still closes the room for a host, so it goes through the
            same confirmation as any other exit. */}
        <Button variant="ghost" block onClick={state.requestLeave}>
          {t('over.home')}
        </Button>
        <p className="action-bar__hint" role="status">
          {required > 0
            ? t('over.playAgainWaiting', { agreed: agreed.length, required })
            : t('over.playAgainHint')}
        </p>
      </div>

      <p className="text-small muted center">{t('over.noPersistence')}</p>
    </div>
  );
}
