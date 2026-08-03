import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../components/Button.tsx';
import { Modal } from '../components/Modal.tsx';
import { CreateRoomScreen } from '../features/game/ui/screens/CreateRoomScreen.tsx';
import { GameOverScreen } from '../features/game/ui/screens/GameOverScreen.tsx';
import { GameScreen } from '../features/game/ui/screens/GameScreen.tsx';
import { HomeScreen } from '../features/game/ui/screens/HomeScreen.tsx';
import { JoinRoomScreen } from '../features/game/ui/screens/JoinRoomScreen.tsx';
import { LobbyScreen } from '../features/game/ui/screens/LobbyScreen.tsx';
import { useAppStore, type Screen } from '../features/game/state/store.ts';
import type { TranslationKey } from '../i18n/index.ts';
import { Announcer } from './Announcer.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { LeaveRoomDialog } from './LeaveRoomDialog.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { screenFromHash } from './routing.ts';
import { TopBar } from './TopBar.tsx';
import { RejectionToast } from './RejectionToast.tsx';
import { useShellEffects } from './useShellEffects.ts';
import { useT } from './useT.ts';

function CurrentScreen({ screen }: { readonly screen: Screen }): ReactNode {
  switch (screen) {
    case 'home':
      return <HomeScreen />;
    case 'create':
      return <CreateRoomScreen />;
    case 'join':
      return <JoinRoomScreen />;
    case 'lobby':
      return <LobbyScreen />;
    case 'game':
      return <GameScreen />;
    case 'over':
      return <GameOverScreen />;
  }
}

/** What a screen change is announced as, so it is never a silent jump. */
const SCREEN_TITLE: Record<Screen, TranslationKey> = {
  home: 'app.title',
  create: 'create.title',
  join: 'join.title',
  lobby: 'lobby.title',
  game: 'game.table',
  over: 'over.title',
};

/** Explains why a room ended, and offers the only two honest ways forward. */
function ClosedRoomDialog(): ReactNode {
  const t = useT();
  const closedReason = useAppStore((state) => state.closedReason);
  const dismissClosed = useAppStore((state) => state.dismissClosed);
  const goTo = useAppStore((state) => state.goTo);

  if (!closedReason || closedReason === 'leftVoluntarily') {
    return null;
  }

  return (
    <Modal
      open
      title={t('error.title')}
      onClose={dismissClosed}
      actions={
        <>
          <Button
            onClick={() => {
              dismissClosed();
              goTo('create');
            }}
          >
            {t('error.startNewRoom')}
          </Button>
          <Button variant="primary" onClick={dismissClosed}>
            {t('error.backHome')}
          </Button>
        </>
      }
    >
      <p>{t(`closed.${closedReason}`)}</p>
    </Modal>
  );
}

export function App(): ReactNode {
  const t = useT();
  const language = useAppStore((state) => state.language);
  const screen = useAppStore((state) => state.screen);
  const goTo = useAppStore((state) => state.goTo);
  const announce = useAppStore((state) => state.announce);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useShellEffects(screen);

  // Deep links: invite URLs.
  useEffect(() => {
    if (screenFromHash(window.location.hash) === 'join') {
      goTo('join');
    }
  }, [goTo]);

  /*
   * A screen change moves no focus — pulling focus out from under a player who
   * is mid-gesture is worse than leaving it — so it is announced instead. That
   * is what a sighted player gets for free from the heading changing.
   */
  useEffect(() => {
    announce(t(SCREEN_TITLE[screen]));
  }, [screen, announce, t]);

  return (
    <div className={`app-shell${screen === 'game' ? ' app-shell--fixed' : ''}`}>
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <TopBar
        settingsOpen={settingsOpen}
        onOpenSettings={() => {
          setSettingsOpen(true);
        }}
      />
      <main id="main" tabIndex={-1}>
        <ErrorBoundary language={language}>
          <CurrentScreen screen={screen} />
        </ErrorBoundary>
      </main>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
        }}
      />
      <ClosedRoomDialog />
      <LeaveRoomDialog />
      <RejectionToast />
      <Announcer />
    </div>
  );
}
