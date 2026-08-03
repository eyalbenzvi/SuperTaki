import type { ReactNode } from 'react';
import { useT } from '../../../../app/useT.ts';
import { standings, winnerName } from '../../state/selectors.ts';
import { useAppStore } from '../../state/store.ts';
import { ConnectionPhaseNotice } from '../components/ConnectionPhaseNotice.tsx';

export function GameOverScreen(): ReactNode {
  const t = useT();
  const state = useAppStore();
  const rows = standings(state);
  const winner = state.publicState?.winnerId ?? null;
  const iWon = winner !== null && winner === state.localPlayerId;
  const agreed = state.playAgain?.agreed ?? [];
  const required = state.playAgain?.required ?? 0;
  const iAgreed = state.localPlayerId !== null && agreed.includes(state.localPlayerId);

  return (
    <div className="page">
      <ConnectionPhaseNotice />

      <h1>{t('over.title')}</h1>
      <p className="hero__subtitle">
        {iWon ? t('over.winnerYou') : t('over.winner', { name: winnerName(state) ?? '—' })}
      </p>

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
                  {row.name}
                  {row.playerId === state.localPlayerId ? (
                    <span className="text-small muted"> ({t('common.you')})</span>
                  ) : null}
                </td>
                <td>{row.cardCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="btn-group">
        <button
          type="button"
          className="btn btn--primary btn--large"
          aria-pressed={iAgreed}
          onClick={() => {
            state.votePlayAgain(!iAgreed);
          }}
        >
          {t('over.playAgain')}
        </button>
        <button type="button" className="btn" onClick={state.leaveRoom}>
          {t('over.home')}
        </button>
      </div>

      <p className="text-small muted" role="status">
        {required > 0
          ? t('over.playAgainWaiting', { agreed: agreed.length, required })
          : t('over.playAgainHint')}
      </p>
      <p className="text-small muted">{t('over.noPersistence')}</p>
    </div>
  );
}
