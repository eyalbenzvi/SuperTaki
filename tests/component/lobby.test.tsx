import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import {
  GUEST_ID,
  HOST_ID,
  lobbyFixture,
  renderApp,
  resetStore,
  setState,
  statusRegions,
} from './helpers.tsx';

beforeEach(resetStore);

function enterLobby(patch: Parameters<typeof setState>[0] = {}): void {
  setState({
    screen: 'lobby',
    role: 'host',
    phase: 'connected',
    localPlayerId: HOST_ID,
    roomCode: 'TIGER-MANGO-42',
    hostPeerId: 'crush-tiger-mango-42',
    inviteUrl: 'https://example.github.io/color-rush/#/join?room=TIGER-MANGO-42',
    lobby: lobbyFixture(),
    ...patch,
  });
}

describe('lobby', () => {
  it('leads with the room code, and keeps the link behind a disclosure', async () => {
    enterLobby();
    const { user } = renderApp();
    expect(screen.getByText('TIGER-MANGO-42')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'העתקת הקוד' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'העתקת קישור' })).toBeInTheDocument();

    // The raw URL is three wrapped lines nobody types by hand: available, not loud.
    await user.click(screen.getByText('קישור הזמנה'));
    expect(
      screen.getByText('https://example.github.io/color-rush/#/join?room=TIGER-MANGO-42'),
    ).toBeInTheDocument();
  });

  it('lists players in seat order with host and self markers', () => {
    enterLobby();
    renderApp();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('דנה');
    expect(within(items[0] as HTMLElement).getByText('מנחה')).toBeInTheDocument();
    expect(items[0]).toHaveTextContent('(את/ה)');
    expect(items[1]).toHaveTextContent('אלי');
  });

  it('shows the player count against the limit', () => {
    enterLobby();
    renderApp();
    expect(screen.getByText('2 מתוך 4 שחקנים')).toBeInTheDocument();
  });

  it('shows connection health per player', () => {
    enterLobby({
      lobby: lobbyFixture({
        players: [
          { id: HOST_ID, name: 'דנה', isHost: true, health: 'connected', seat: 0 },
          { id: GUEST_ID, name: 'אלי', isHost: false, health: 'unstable', seat: 1 },
        ],
      }),
    });
    renderApp();
    expect(screen.getByText('לא יציב')).toBeInTheDocument();
  });

  it('lets the host remove a guest but not themselves, and confirms first', async () => {
    const removePlayer = vi.fn();
    enterLobby({ removePlayer });
    const { user } = renderApp();

    expect(screen.queryByRole('button', { name: 'הסרת דנה' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'הסרת אלי' }));

    // The control sits beside a name in a list — exactly the shape of a mis-tap —
    // and throwing somebody out cannot be undone from their side.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('להסיר את אלי?');
    expect(removePlayer).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'הסרת השחקן' }));
    expect(removePlayer).toHaveBeenCalledWith(GUEST_ID);
  });

  it('can back out of removing a player', async () => {
    const removePlayer = vi.fn();
    enterLobby({ removePlayer });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'הסרת אלי' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ביטול' }));
    expect(removePlayer).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('nudges a host who is still on their own', () => {
    enterLobby({
      lobby: lobbyFixture({
        players: [{ id: HOST_ID, name: 'דנה', isHost: true, health: 'connected', seat: 0 }],
      }),
    });
    renderApp();
    expect(screen.getByText(/שתפו את קוד החדר/)).toBeInTheDocument();
  });

  it('starts the game directly when everyone is fully connected', async () => {
    const startGame = vi.fn();
    enterLobby({ startGame });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'התחלת המשחק' }));
    expect(startGame).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirms before starting with an unstable player', async () => {
    const startGame = vi.fn();
    enterLobby({
      startGame,
      lobby: lobbyFixture({
        players: [
          { id: HOST_ID, name: 'דנה', isHost: true, health: 'connected', seat: 0 },
          { id: GUEST_ID, name: 'אלי', isHost: false, health: 'unstable', seat: 1 },
        ],
      }),
    });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'התחלת המשחק' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('להתחיל עם חיבור לא יציב?');
    expect(startGame).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'להתחיל בכל זאת' }));
    expect(startGame).toHaveBeenCalledTimes(1);
  });

  it('disables the start button below two players', () => {
    enterLobby({
      lobby: lobbyFixture({
        players: [{ id: HOST_ID, name: 'דנה', isHost: true, health: 'connected', seat: 0 }],
      }),
    });
    renderApp();
    expect(screen.getByRole('button', { name: 'התחלת המשחק' })).toBeDisabled();
    expect(screen.getByText('נדרשים לפחות 2 שחקנים.')).toBeInTheDocument();
  });

  it('hides host controls from guests and tells them what to expect', () => {
    enterLobby({ role: 'client', localPlayerId: GUEST_ID });
    renderApp();
    expect(screen.queryByRole('button', { name: 'התחלת המשחק' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'הסרת אלי' })).not.toBeInTheDocument();
    expect(statusRegions()[0]).toHaveTextContent('ממתינים שהמנחה יתחיל');
  });

  it('confirms leaving, warning the host about closing the room', async () => {
    const leaveRoom = vi.fn();
    enterLobby({ leaveRoom });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'יציאה' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('יציאה תסגור את החדר לכולם');
    await user.click(within(dialog).getByRole('button', { name: 'יציאה' }));
    expect(leaveRoom).toHaveBeenCalled();
  });

  it('lets the host change the maximum player count', async () => {
    const setMaxPlayers = vi.fn();
    enterLobby({ setMaxPlayers });
    const { user } = renderApp();

    await user.click(screen.getByText('הגדרות החדר'));
    const group = screen.getByRole('radiogroup', { name: 'מספר שחקנים מקסימלי' });
    await user.click(within(group).getByRole('radio', { name: '5' }));
    expect(setMaxPlayers).toHaveBeenCalledWith(5);
  });
});

describe('sharing the invite', () => {
  it('copies the link and confirms it', async () => {
    enterLobby();
    const { user } = renderApp();
    // Stub after userEvent.setup(), which installs its own clipboard shim.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, share: undefined });

    await user.click(screen.getByRole('button', { name: 'העתקת קישור' }));
    expect(writeText).toHaveBeenCalledWith('https://example.github.io/color-rush/#/join?room=TIGER-MANGO-42');
    expect(await screen.findByRole('button', { name: 'הועתק' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('explains it when copying is not possible', async () => {
    enterLobby();
    const { user } = renderApp();
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined, share: undefined });
    Object.defineProperty(document, 'execCommand', {
      value: () => false,
      configurable: true,
    });

    await user.click(screen.getByRole('button', { name: 'העתקת קישור' }));
    expect(await screen.findByText('שיתוף אינו נתמך בדפדפן הזה. אפשר להעתיק את הקישור.')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('offers the native share sheet where the browser supports it', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share, clipboard: { writeText: vi.fn() } });
    enterLobby();
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'שיתוף' }));
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.github.io/color-rush/#/join?room=TIGER-MANGO-42',
      }),
    );
    vi.unstubAllGlobals();
  });

  it('hides the share button when the browser has no Web Share API', () => {
    vi.stubGlobal('navigator', { ...navigator, share: undefined });
    enterLobby();
    renderApp();
    expect(screen.queryByRole('button', { name: 'שיתוף' })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

describe('connection notices', () => {
  it('stays quiet while connected', () => {
    enterLobby();
    renderApp();
    expect(screen.queryByText('מתחבר מחדש…')).not.toBeInTheDocument();
  });

  it('shows a reconnection notice without an escape hatch', () => {
    enterLobby({ phase: 'reconnecting' });
    renderApp();
    expect(screen.getByText('מתחבר מחדש…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'חזרה לדף הבית' })).not.toBeInTheDocument();
  });

  it('explains a failure honestly and offers a retry to guests', async () => {
    const retryConnection = vi.fn();
    enterLobby({
      role: 'client',
      localPlayerId: GUEST_ID,
      phase: 'failed',
      error: { code: 'signalingUnavailable', retryable: true },
      retryConnection,
    });
    const { user } = renderApp();

    expect(screen.getByText(/לא הצלחנו להגיע לשירות החיבור החינמי/)).toBeInTheDocument();
    expect(screen.getByText('למה זה קורה?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'נסה שוב' }));
    expect(retryConnection).toHaveBeenCalled();
  });

  it('does not offer a retry for a non-retryable failure', () => {
    enterLobby({
      role: 'client',
      localPlayerId: GUEST_ID,
      phase: 'failed',
      error: { code: 'gameInProgress', retryable: false },
    });
    renderApp();
    expect(screen.getByText(/המשחק כבר התחיל/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'נסה שוב' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'חזרה לדף הבית' })).toBeInTheDocument();
  });

  it('explains why a closed room cannot continue', () => {
    setState({ screen: 'home', closedReason: 'hostLeft' });
    renderApp();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('המנחה יצא');
    expect(dialog).toHaveTextContent('לא יכול להמשיך בלי המנחה');
    expect(within(dialog).getByRole('button', { name: 'פתיחת חדר חדש' })).toBeInTheDocument();
  });

  it('says nothing extra when the player left on purpose', () => {
    setState({ screen: 'home', closedReason: 'leftVoluntarily' });
    renderApp();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
