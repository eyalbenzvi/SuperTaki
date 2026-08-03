import { useEffect, useRef } from 'react';
import { useAppStore, type Screen } from '../features/game/state/store.ts';

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
      if (state.role !== null && IN_ROOM.has(state.screen)) {
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
   * A refresh or a closed tab during play costs the host's room outright, and
   * costs a guest their turn. The browser's own confirmation is the only hook
   * available, and it is worth using for exactly this window.
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
