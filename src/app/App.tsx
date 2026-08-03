import { useEffect, type ReactNode } from 'react';
import { Modal } from '../components/Modal.tsx';
import { CreateRoomScreen } from '../features/game/ui/screens/CreateRoomScreen.tsx';
import { GameOverScreen } from '../features/game/ui/screens/GameOverScreen.tsx';
import { GameScreen } from '../features/game/ui/screens/GameScreen.tsx';
import { HomeScreen } from '../features/game/ui/screens/HomeScreen.tsx';
import { JoinRoomScreen } from '../features/game/ui/screens/JoinRoomScreen.tsx';
import { LobbyScreen } from '../features/game/ui/screens/LobbyScreen.tsx';
import { RulesScreen } from '../features/game/ui/screens/RulesScreen.tsx';
import { useAppStore } from '../features/game/state/store.ts';
import { screenFromHash } from './routing.ts';
import { TopBar } from './TopBar.tsx';
import { RejectionToast } from './RejectionToast.tsx';
import { useT } from './useT.ts';

function CurrentScreen(): ReactNode {
  const screen = useAppStore((state) => state.screen);
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
    case 'rules':
      return <RulesScreen />;
  }
}

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
          <button
            type="button"
            className="btn"
            onClick={() => {
              dismissClosed();
              goTo('create');
            }}
          >
            {t('error.startNewRoom')}
          </button>
          <button type="button" className="btn btn--primary" onClick={dismissClosed}>
            {t('error.backHome')}
          </button>
        </>
      }
    >
      <p>{t(`closed.${closedReason}`)}</p>
    </Modal>
  );
}

export function App(): ReactNode {
  const t = useT();
  const goTo = useAppStore((state) => state.goTo);
  const openRules = useAppStore((state) => state.openRules);

  // Deep links: invite URLs and the rules page.
  useEffect(() => {
    const target = screenFromHash(window.location.hash);
    if (target === 'join') {
      goTo('join');
    } else if (target === 'rules') {
      openRules();
    }
  }, [goTo, openRules]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <TopBar />
      <main id="main" tabIndex={-1}>
        <CurrentScreen />
      </main>
      <ClosedRoomDialog />
      <RejectionToast />
    </div>
  );
}
