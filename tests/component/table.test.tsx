import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { GUEST_ID, HOST_ID, enterGame, lobbyFixture, renderApp, resetStore, setState } from './helpers.tsx';
import type { Card } from '../../src/features/game/engine/cards.ts';

beforeEach(resetStore);

const red5: Card = { id: 'c1', kind: 'number', color: 'red', value: 5 };
const red7: Card = { id: 'c2', kind: 'number', color: 'red', value: 7 };
const blue2: Card = { id: 'c3', kind: 'number', color: 'blue', value: 2 };
const red9: Card = { id: 'c4', kind: 'number', color: 'red', value: 9 };

function table(options: { hand: readonly Card[]; myTurn?: boolean; patch?: Record<string, unknown> }): void {
  const fixture = enterGame({ myTurn: options.myTurn ?? true });
  setState({
    hand: options.hand,
    publicState: {
      ...fixture.publicState,
      currentPlayerId: (options.myTurn ?? true) ? HOST_ID : GUEST_ID,
      discardTop: red9,
      activeColor: 'red',
      players: [
        { id: HOST_ID, name: 'דנה', cardCount: options.hand.length },
        { id: GUEST_ID, name: 'אלי', cardCount: 5 },
      ],
      ...options.patch,
    },
  });
}

describe('the hand as a keyboard widget', () => {
  it('exposes one tab stop and moves along the fan with the arrow keys', async () => {
    // Right-to-left is the default, so ArrowLeft moves the way the key points.
    table({ hand: [blue2, red5, red7] });
    const { user } = renderApp();

    const cards = screen.getAllByRole('button', { name: /^הנחת/ });
    const stops = cards.filter((card) => card.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    // The tab stop starts on the first card that can actually be played.
    expect(stops[0]).toHaveAccessibleName('הנחת אדום 5');

    stops[0]?.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toHaveAccessibleName('הנחת אדום 7');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAccessibleName('הנחת אדום 5');
    // Home and End follow the fan's own order, which is the sorted hand:
    // red 5, red 7, blue 2.
    await user.keyboard('{End}');
    expect(document.activeElement).toHaveAccessibleName('הנחת כחול 2');
    await user.keyboard('{Home}');
    expect(document.activeElement).toHaveAccessibleName('הנחת אדום 5');
  });

  it('plays the focused card with the keyboard', async () => {
    const playCard = vi.fn();
    table({ hand: [red5] });
    setState({ playCard });
    const { user } = renderApp();

    screen.getByRole('button', { name: 'הנחת אדום 5' }).focus();
    await user.keyboard('{Enter}');
    expect(playCard).toHaveBeenCalledWith(red5.id);
  });

  it('shows the hand in colour order rather than deal order', () => {
    table({ hand: [blue2, red7, red5] });
    renderApp();
    expect(
      screen.getAllByRole('button', { name: /^הנחת/ }).map((card) => card.getAttribute('aria-label')),
    ).toEqual(['הנחת אדום 5', 'הנחת אדום 7', 'הנחת כחול 2']);
  });
});

describe('a move in flight', () => {
  it('locks the hand and the pile until the table answers', async () => {
    const playCard = vi.fn();
    table({ hand: [red5, red7] });
    setState({ playCard, actionPending: true });
    const { user } = renderApp();

    // One tap must never become two moves: the host would reject the duplicate,
    // and the player would be told a card they legitimately played is not theirs.
    await user.click(screen.getByRole('button', { name: 'הנחת אדום 5' }));
    expect(playCard).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /חבילת משיכה/ })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('שולח את המהלך…');
  });

  it('says so in the prompt while waiting', () => {
    table({ hand: [red5] });
    setState({ actionPending: true });
    renderApp();
    expect(screen.getByText('שולח את המהלך…')).toBeInTheDocument();
  });
});

describe('what to do now', () => {
  it('tells a player on turn that they may play or draw', () => {
    table({ hand: [red5] });
    renderApp();
    expect(screen.getByText('אפשר להניח קלף או למשוך.')).toBeInTheDocument();
  });

  it('names the player being waited for when it is not your turn', () => {
    table({ hand: [red5], myTurn: false });
    renderApp();
    expect(screen.getByText('ממתינים לאלי…')).toBeInTheDocument();
  });

  it('shows one prompt at a time, in priority order', () => {
    // A pending draw and a pending Plus at once: the debt is the thing to answer.
    table({ hand: [red5], patch: { pendingDraw: 2, pendingPlus: true } });
    renderApp();
    expect(screen.getByText('מחכים לך 2 קלפים. אפשר לענות בקח 2 או במלך, או לקחת אותם.')).toBeInTheDocument();
    expect(screen.queryByText('הונח פלוס — חייבים להניח עוד קלף.')).not.toBeInTheDocument();
  });

  it('uses the singular when a single card is owed', () => {
    table({ hand: [red5], patch: { pendingDraw: 1 } });
    renderApp();
    expect(screen.getByRole('button', { name: 'לקיחת קלף אחד' })).toBeInTheDocument();
  });
});

describe('the other players', () => {
  it('marks the player on turn without saying it is your turn', () => {
    table({ hand: [red5], myTurn: false });
    renderApp();
    const seats = screen.getByRole('region', { name: 'שאר השחקנים' });
    // The old badge read "your turn" on somebody else's seat.
    expect(within(seats).getByText('משחק/ת עכשיו')).toBeInTheDocument();
    expect(within(seats).queryByText('תור שלך')).not.toBeInTheDocument();
  });

  it('calls out an opponent down to their last card', () => {
    const fixture = enterGame({ myTurn: true });
    setState({
      hand: [red5],
      publicState: {
        ...fixture.publicState,
        currentPlayerId: HOST_ID,
        players: [
          { id: HOST_ID, name: 'דנה', cardCount: 1 },
          { id: GUEST_ID, name: 'אלי', cardCount: 1 },
        ],
      },
      lobby: lobbyFixture({ phase: 'inGame' }),
    });
    renderApp();
    const seats = screen.getByRole('region', { name: 'שאר השחקנים' });
    expect(within(seats).getByText('קלף אחד')).toBeInTheDocument();
    expect(within(seats).getByText('קלף אחרון!')).toBeInTheDocument();
  });
});

describe('the connection, in player-friendly words', () => {
  it('explains an offline device rather than blaming the room', () => {
    table({ hand: [red5] });
    // The shell reads `navigator.onLine` on mount, so the browser has to be the
    // one that is offline.
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    renderApp();
    expect(screen.getByText('המכשיר הזה לא מחובר לאינטרנט')).toBeInTheDocument();
    expect(screen.getByText(/המושב שלך נשמר/)).toBeInTheDocument();
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  });

  it('says the seat is being held while reconnecting', () => {
    table({ hand: [red5] });
    setState({ phase: 'reconnecting' });
    renderApp();
    expect(screen.getByText('מתחבר מחדש…')).toBeInTheDocument();
    expect(screen.getByText(/המושב שלך נשמר/)).toBeInTheDocument();
  });
});

describe('leaving', () => {
  it('is one confirmation, wherever the request came from', async () => {
    const leaveRoom = vi.fn();
    table({ hand: [red5] });
    setState({ leaveRoom });
    const { user } = renderApp();

    // The shell owns it, so the top bar, the Back button and the end-of-round
    // screen all go through the same warning with the same wording.
    await user.click(screen.getByRole('button', { name: 'יציאה' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('לצאת מהמשחק?');
    expect(dialog).toHaveTextContent('יציאה תסיים את המשחק לכולם');
    expect(leaveRoom).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'יציאה' }));
    expect(leaveRoom).toHaveBeenCalled();
  });
});
