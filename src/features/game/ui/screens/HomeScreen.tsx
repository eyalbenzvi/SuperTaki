import type { ReactNode } from 'react';
import { BrandMark } from '../../../../app/BrandMark.tsx';
import { Button } from '../../../../components/Button.tsx';
import { useT } from '../../../../app/useT.ts';
import { useAppStore } from '../../state/store.ts';
import { ResumeCard } from '../components/ResumeCard.tsx';

/**
 * The landing screen.
 *
 * Two ways in, one of them obviously the main one, and three lines explaining
 * what this thing is — a player arriving from a link has never seen it before,
 * and "create or join?" is not a question you can answer without knowing that
 * one person opens a room and everyone else comes to it.
 */
export function HomeScreen(): ReactNode {
  const t = useT();
  const goTo = useAppStore((state) => state.goTo);
  const busy = useAppStore((state) => state.busy);
  const resumable = useAppStore((state) => state.resumable);
  const joinRoom = useAppStore((state) => state.joinRoom);

  return (
    <div className="page page--home">
      <div className="hero">
        <h1 className="hero__title">
          <BrandMark />
        </h1>
        <p className="hero__subtitle">{t('app.subtitle')}</p>
      </div>

      {/*
        One tap, and it reconnects — it does not walk the player to the join screen to
        ask again. This is the whole of what a reload costs now: there used to be a
        second card here offering to reinstate a room from a copy of the game in
        `localStorage`, and it was the only way a table survived its creator pressing
        refresh. The room survives that by itself, so what is left is a seat to take
        back, and every player takes theirs the same way.
      */}
      <ResumeCard
        busy={busy}
        onResume={() => {
          if (resumable) {
            void joinRoom({
              name: resumable.displayName,
              roomCode: resumable.roomCode,
              resume: { playerId: resumable.playerId, resumeToken: resumable.resumeToken },
            });
          }
        }}
      />

      <div className="home-actions">
        <Button
          variant="primary"
          size="lg"
          block
          onClick={() => {
            goTo('create');
          }}
        >
          {t('home.create')}
        </Button>
        <Button
          size="lg"
          block
          onClick={() => {
            goTo('join');
          }}
        >
          {t('home.join')}
        </Button>
      </div>

      <section className="steps" aria-labelledby="how-title">
        <h2 className="steps__title" id="how-title">
          {t('home.howTitle')}
        </h2>
        <ol className="steps__list">
          <li>{t('home.step1')}</li>
          <li>{t('home.step2')}</li>
          <li>{t('home.step3')}</li>
        </ol>
      </section>
    </div>
  );
}
