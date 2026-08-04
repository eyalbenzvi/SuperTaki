import type { ReactNode } from 'react';
import { Badge } from '../../../../components/Badge.tsx';
import { Button } from '../../../../components/Button.tsx';
import { Icon } from '../../../../components/Icon.tsx';
import { useT } from '../../../../app/useT.ts';
import { standings, wasAbandoned, winnerName } from '../../state/selectors.ts';
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
  const winner = state.publicState?.winnerId ?? null;
  const abandoned = wasAbandoned(state);
  const iWon = winner !== null && winner === state.localPlayerId;
  const agreed = state.playAgain?.agreed ?? [];
  const required = state.playAgain?.required ?? 0;
  const iAgreed = state.localPlayerId !== null && agreed.includes(state.localPlayerId);

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
                  </span>
                </td>
                {/* The column header carries the unit; repeating it in every
                    cell just makes the table harder to scan. */}
                <td className="standings__count">{row.cardCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

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
