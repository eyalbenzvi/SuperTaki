import type { ReactNode } from 'react';
import { BrandMark } from '../../../../app/BrandMark.tsx';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';

export function HomeScreen(): ReactNode {
  const t = useT();
  const goTo = useAppStore((state) => state.goTo);
  const resumable = useAppStore((state) => state.resumable);
  const forgetResumable = useAppStore((state) => state.forgetResumable);

  return (
    <div className="page">
      <div className="hero">
        <h1 className="hero__title">
          <BrandMark />
        </h1>
        <p className="hero__subtitle">{t('app.subtitle')}</p>
      </div>

      {resumable ? (
        <div className="notice notice--info">
          <strong>{t('join.resumeTitle')}</strong>
          <span>{t('join.resumeBody', { room: resumable.roomCode, name: resumable.displayName })}</span>
          <div className="btn-group">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                goTo('join');
              }}
            >
              {t('join.resumeAction')}
            </button>
            <button type="button" className="btn btn--ghost" onClick={forgetResumable}>
              {t('join.resumeDiscard')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="home-actions">
        <button
          type="button"
          className="btn btn--primary btn--large btn--block"
          onClick={() => {
            goTo('create');
          }}
        >
          {t('home.create')}
        </button>
        <button
          type="button"
          className="btn btn--large btn--block"
          onClick={() => {
            goTo('join');
          }}
        >
          {t('home.join')}
        </button>
      </div>
    </div>
  );
}
