import { render, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { App } from '../../src/app/App.tsx';
import { createGame } from '../../src/features/game/engine/engine.ts';
import { toPrivateHandView, toPublicGameState } from '../../src/features/game/engine/views.ts';
import type { PublicGameState } from '../../src/features/game/engine/views.ts';
import type { LobbySnapshot } from '../../src/features/game/network/protocol.ts';
import { useAppStore, type AppStore } from '../../src/features/game/state/store.ts';
import type { Card } from '../../src/features/game/engine/cards.ts';

/** Pristine store contents, captured before any test mutates them. */
const PRISTINE: AppStore = { ...useAppStore.getState() };

export function resetStore(): void {
  useAppStore.setState({ ...PRISTINE }, true);
  document.documentElement.dir = 'rtl';
  document.documentElement.lang = 'he';
}

export function setState(patch: Partial<AppStore>): void {
  useAppStore.setState(patch);
}

export function renderApp(): RenderResult & { user: ReturnType<typeof userEvent.setup> } {
  const user = userEvent.setup();
  return { ...render(<App />), user };
}

export function renderWithUser(element: ReactElement): RenderResult & {
  user: ReturnType<typeof userEvent.setup>;
} {
  const user = userEvent.setup();
  return { ...render(element), user };
}

export const HOST_ID = 'pl_host000000';
export const GUEST_ID = 'pl_guest00000';

export function lobbyFixture(overrides: Partial<LobbySnapshot> = {}): LobbySnapshot {
  return {
    roomCode: 'TIGER-MANGO-42',
    hostPeerId: 'crush-tiger-mango-42',
    hostPlayerId: HOST_ID,
    maxPlayers: 4,
    phase: 'lobby',
    tableLanguage: 'he',
    players: [
      { id: HOST_ID, name: 'דנה', isHost: true, health: 'connected', seat: 0 },
      { id: GUEST_ID, name: 'אלי', isHost: false, health: 'connected', seat: 1 },
    ],
    ...overrides,
  };
}

export interface GameFixture {
  publicState: PublicGameState;
  hand: readonly Card[];
}

/** A started two-player game, viewed from the host's seat. */
export function gameFixture(seed = 2024): GameFixture {
  const result = createGame(
    [
      { id: HOST_ID, name: 'דנה' },
      { id: GUEST_ID, name: 'אלי' },
    ],
    seed,
  );
  if (!result.ok) {
    throw new Error('fixture failed');
  }
  return {
    publicState: toPublicGameState(result.state),
    hand: toPrivateHandView(result.state, HOST_ID).cards,
  };
}

/** Puts the app straight into an in-progress game as the host. */
export function enterGame(options: { myTurn?: boolean; seed?: number } = {}): GameFixture {
  const fixture = gameFixture(options.seed);
  const myTurn = options.myTurn ?? true;
  setState({
    screen: 'game',
    role: 'host',
    phase: 'connected',
    localPlayerId: HOST_ID,
    roomCode: 'TIGER-MANGO-42',
    hostPeerId: 'crush-tiger-mango-42',
    lobby: lobbyFixture({ phase: 'inGame' }),
    publicState: {
      ...fixture.publicState,
      currentPlayerId: myTurn ? HOST_ID : GUEST_ID,
    },
    hand: fixture.hand,
  });
  return fixture;
}

export { userEvent };
