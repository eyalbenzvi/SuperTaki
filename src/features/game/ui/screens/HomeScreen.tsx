import type { ReactNode } from 'react';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';

/** Splits the title into letters so each can take a card colour. */
function ColorTitle({ title }: { readonly title: string }): ReactNode {
  return (
    <span className="hero__letters" aria-hidden="true">
      {[...title].map((letter, index) => (
        <span className="hero__letter" key={`${letter}-${index}`}>
          {letter === ' ' ? ' ' : letter}
        </span>
      ))}
    </span>
  );
}

export function HomeScreen(): ReactNode {
  const t = useT();
  const goTo = useAppStore((state) => state.goTo);
  const openRules = useAppStore((state) => state.openRules);
  const resumable = useAppStore((state) => state.resumable);
  const forgetResumable = useAppStore((state) => state.forgetResumable);

  return (
    <div className="page">
      <div className="hero">
        <h1 className="hero__title">
          <span className="sr-only">{t('app.title')}</span>
          <ColorTitle title={t('app.title')} />
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
        <button type="button" className="btn btn--large btn--block" onClick={openRules}>
          {t('home.rules')}
        </button>
      </div>

      <div className="notice">{t('home.connectionNote')}</div>

      <section className="panel">
        <h2 className="panel__title">{t('home.privacyTitle')}</h2>
        <p className="text-small muted">{t('home.privacyNote')}</p>
        <p className="text-small muted">{t('home.disclaimer')}</p>
      </section>
    </div>
  );
}
