import { useEffect, useRef } from 'react';
import { useAppStore, type Screen } from '../features/game/state/store.ts';
import { onWake } from '../lib/lifecycle.ts';
import { refreshWakeLock, releaseWakeLock, requestWakeLock } from '../lib/wakeLock.ts';

/** Screens that mean "seated in a room", where a stray Back must not eject you. */
const IN_ROOM: ReadonlySet<Screen> = new Set<Screen>(['lobby', 'game', 'over']);

/** Marker on the history entries this app pushes, so it can recognise its own. */
interface ShellHistoryState {
  readonly superTakiDepth: number;
}

function depthOf(state: unknown): number {
  return typeof state === 'object' && state !== null && 'superTakiDepth' in state
    ? Number((state as ShellHistoryState).superTakiDepth)
    : 0;
}

/**
 * Connects the app to the three browser-level facts it has to respect:
 * the network going away, the Back button, and the tab being closed mid-game.
 */
export function useShellEffects(screen: Screen): void {
  const setOnline = useAppStore((state) => state.setOnline);
  const depth = useRef(0);

  // The transport reacts to these too; the UI needs them to explain itself.
  useEffect(() => {
    const update = (): void => {
      setOnline(navigator.onLine !== false);
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [setOnline]);

  /*
   * Back-button behaviour.
   *
   * Every screen past the landing page pushes one history entry, so Android's
   * back gesture moves inside the app instead of closing it. While seated in a
   * room, Back is intercepted: the entry is pushed straight back and the leave
   * confirmation opens, because leaving is destructive — for a host it closes the
   * room for everyone — and must never happen by accident.
   *
   * Each entry carries its own depth, and a `popstate` is only treated as a Back
   * press when the entry it lands on is shallower than the one we were on.
   * Without that check, anything else that fires `popstate` — a jump to a
   * fragment, the skip link, an invite hash being cleared — would look like a
   * back press and throw the player off the screen they are on.
   */
  useEffect(() => {
    if (screen === 'home') {
      return;
    }
    depth.current += 1;
    const state: ShellHistoryState = { superTakiDepth: depth.current };
    window.history.pushState(state, '');
  }, [screen]);

  useEffect(() => {
    const onPopState = (): void => {
      const landed = depthOf(window.history.state);
      if (landed >= depth.current) {
        return;
      }
      depth.current = landed;

      const state = useAppStore.getState();
      if (state.inRoom && IN_ROOM.has(state.screen)) {
        depth.current += 1;
        window.history.pushState({ superTakiDepth: depth.current } satisfies ShellHistoryState, '');
        state.requestLeave();
        return;
      }
      if (state.screen !== 'home') {
        state.goTo('home');
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  /*
   * Keep the screen awake while a game is on the table.
   *
   * A phone that dims and locks is the most ordinary way a player "disconnects":
   * the tab is suspended, the connection dies with it, and nobody touched
   * anything. This cannot help a backgrounded tab — nothing in a web page can —
   * but it does prevent the case where the game is in front of the player and the
   * device puts itself to sleep regardless. The browser revokes the lock whenever
   * the page is hidden, which is why it is re-requested on every wake.
   */
  useEffect(() => {
    if (screen !== 'game') {
      void releaseWakeLock();
      return;
    }
    void requestWakeLock();
    const off = onWake(() => {
      void refreshWakeLock();
    });
    return () => {
      off();
      void releaseWakeLock();
    };
  }, [screen]);

  /*
   * A refresh or a closed tab during play costs nobody the room any more — it is in
   * the room, not this tab — but it still costs this player the moments it takes to
   * come back, and the table waits on them meanwhile. The browser's own confirmation
   * is the only hook available, and it is worth using for exactly this window.
   */
  useEffect(() => {
    if (screen !== 'game') {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [screen]);
}
