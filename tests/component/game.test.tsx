import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { GUEST_ID, HOST_ID, enterGame, lobbyFixture, renderApp, resetStore, setState } from './helpers.tsx';
import { getPlayableCardIds } from '../../src/features/game/engine/rules.ts';
import { playContextFromPublic } from '../../src/features/game/engine/views.ts';
import type { Card } from '../../src/features/game/engine/cards.ts';

beforeEach(resetStore);

/** Overrides the hand and public state so a specific rule situation is on screen. */
function situation(options: {
  hand: readonly Card[];
  discardTop: Card;
  activeColor: 'red' | 'blue' | 'green' | 'yellow';
  myTurn?: boolean;
  takiMode?: { color: 'red' | 'blue' | 'green' | 'yellow'; openedWithSuperTaki?: boolean } | null;
  pendingPlus?: boolean;
}): void {
  const fixture = enterGame({ myTurn: options.myTurn ?? true });
  setState({
    hand: options.hand,
    publicState: {
      ...fixture.publicState,
      currentPlayerId: (options.myTurn ?? true) ? HOST_ID : GUEST_ID,
      discardTop: options.discardTop,
      activeColor: options.activeColor,
      pendingPlus: options.pendingPlus ?? false,
      takiMode: options.takiMode
        ? {
            color: options.takiMode.color,
            playerId: HOST_ID,
            cardsPlayed: 1,
            openedWithSuperTaki: options.takiMode.openedWithSuperTaki ?? false,
          }
        : null,
      players: [
        { id: HOST_ID, name: 'דנה', cardCount: options.hand.length },
        { id: GUEST_ID, name: 'אלי', cardCount: 5 },
      ],
    },
  });
}

const red5: Card = { id: 'c1', kind: 'number', color: 'red', value: 5 };
const blue5: Card = { id: 'c2', kind: 'number', color: 'blue', value: 5 };
const blue2: Card = { id: 'c3', kind: 'number', color: 'blue', value: 2 };
const redStop: Card = { id: 'c4', kind: 'stop', color: 'red' };
const superTaki: Card = { id: 'c5', kind: 'superTaki' };
const colorChange: Card = { id: 'c6', kind: 'colorChange' };
const redTaki: Card = { id: 'c7', kind: 'taki', color: 'red' };
const red9: Card = { id: 'c8', kind: 'number', color: 'red', value: 9 };

describe('table layout', () => {
  it('shows the opponent face down with a card count, never their cards', () => {
    enterGame();
    renderApp();
    const opponents = screen.getByRole('region', { name: 'שאר השחקנים' });
    expect(within(opponents).getByText('אלי')).toBeInTheDocument();
    expect(within(opponents).getByText('8 קלפים')).toBeInTheDocument();
    expect(within(opponents).getByRole('img', { name: 'קלף הפוך' })).toBeInTheDocument();
  });

  it('shows the current colour, direction and whose turn it is', () => {
    enterGame();
    renderApp();
    expect(screen.getByText(/הצבע הנוכחי:/)).toBeInTheDocument();
    expect(screen.getByText('כיוון המשחק: קדימה')).toBeInTheDocument();
    expect(screen.getByText('תור שלך')).toBeInTheDocument();
  });

  it('names the opponent when it is their turn', () => {
    enterGame({ myTurn: false });
    renderApp();
    expect(screen.getByText('התור של אלי')).toBeInTheDocument();
  });

  it('gives the discard top an accessible name', () => {
    const fixture = enterGame();
    renderApp();
    const top = fixture.publicState.discardTop;
    expect(top).not.toBeNull();
    expect(screen.getAllByRole('img').some((node) => node.getAttribute('aria-label')?.length)).toBe(true);
  });
});

describe('legal card highlighting', () => {
  it('enables only the legal cards on your turn', () => {
    situation({ hand: [red5, blue2, colorChange], discardTop: red9, activeColor: 'red' });
    renderApp();

    expect(screen.getByRole('button', { name: 'הנחת אדום 5' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'הנחת שינוי צבע' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'הנחת כחול 2' })).toBeDisabled();
  });

  it('accepts a symbol match across colours', () => {
    situation({ hand: [blue5, blue2], discardTop: red5, activeColor: 'red' });
    renderApp();
    expect(screen.getByRole('button', { name: 'הנחת כחול 5' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'הנחת כחול 2' })).toBeDisabled();
  });

  it('disables the whole hand when it is not your turn', () => {
    situation({ hand: [red5, colorChange], discardTop: red9, activeColor: 'red', myTurn: false });
    renderApp();
    expect(screen.getByRole('button', { name: 'הנחת אדום 5' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'הנחת שינוי צבע' })).toBeDisabled();
  });

  it('agrees with the engine about which cards are legal', () => {
    const hand = [red5, blue2, colorChange, redStop];
    situation({ hand, discardTop: red9, activeColor: 'red' });
    const { publicState } = {
      publicState: { activeColor: 'red' as const, discardTop: red9, takiMode: null },
    };
    const expected = getPlayableCardIds(
      hand,
      playContextFromPublic({
        ...publicState,
        version: 1,
        phase: 'playing',
        players: [],
        drawPileCount: 1,
        discardCount: 1,
        direction: 1,
        currentPlayerId: HOST_ID,
        pendingPlus: false,
        winnerId: null,
      } as never),
    );
    expect(expected).toEqual([red5.id, colorChange.id, redStop.id]);
  });

  it('plays a coloured card straight away', async () => {
    const playCard = vi.fn();
    situation({ hand: [red5, blue2], discardTop: red9, activeColor: 'red' });
    setState({ playCard });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'הנחת אדום 5' }));
    expect(playCard).toHaveBeenCalledWith(red5.id);
  });
});

describe('the draw pile', () => {
  it('is interactive on your turn and announces the count', () => {
    situation({ hand: [blue2], discardTop: red9, activeColor: 'red' });
    renderApp();
    const pile = screen.getByRole('button', { name: /חבילת משיכה, \d+ קלפים/ });
    expect(pile).toBeEnabled();
  });

  it('is disabled when it is not your turn', () => {
    situation({ hand: [blue2], discardTop: red9, activeColor: 'red', myTurn: false });
    renderApp();
    expect(screen.getByRole('button', { name: /חבילת משיכה/ })).toBeDisabled();
  });

  it('is disabled while a Taki sequence is open', () => {
    situation({
      hand: [red5],
      discardTop: redTaki,
      activeColor: 'red',
      takiMode: { color: 'red' },
    });
    renderApp();
    expect(screen.getByRole('button', { name: /חבילת משיכה/ })).toBeDisabled();
  });

  it('tells the player to draw when nothing is legal', () => {
    situation({ hand: [blue2], discardTop: red9, activeColor: 'red' });
    renderApp();
    expect(screen.getByText('אין קלף חוקי. יש למשוך קלף מהחבילה.')).toBeInTheDocument();
  });

  it('draws when clicked', async () => {
    const drawCard = vi.fn();
    situation({ hand: [blue2], discardTop: red9, activeColor: 'red' });
    setState({ drawCard });
    const { user } = renderApp();
    await user.click(screen.getByRole('button', { name: /חבילת משיכה/ }));
    expect(drawCard).toHaveBeenCalled();
  });
});

describe('wild cards and the colour picker', () => {
  it('asks for a colour before playing a wild card', async () => {
    const playCard = vi.fn();
    situation({ hand: [colorChange, red5], discardTop: red9, activeColor: 'red' });
    setState({ playCard });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'הנחת שינוי צבע' }));
    expect(playCard).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('בחירת צבע עבור שינוי צבע');
    for (const color of ['אדום', 'כחול', 'ירוק', 'צהוב']) {
      expect(within(dialog).getByRole('button', { name: color })).toBeInTheDocument();
    }

    await user.click(within(dialog).getByRole('button', { name: 'ירוק' }));
    expect(playCard).toHaveBeenCalledWith(colorChange.id, 'green');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks for a colour for Super Taki too', async () => {
    const playCard = vi.fn();
    situation({ hand: [superTaki], discardTop: red9, activeColor: 'red' });
    setState({ playCard });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'הנחת סופר טאקי' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'אדום' }));
    expect(playCard).toHaveBeenCalledWith(superTaki.id, 'red');
  });

  it('can be cancelled without playing anything', async () => {
    const playCard = vi.fn();
    situation({ hand: [colorChange], discardTop: red9, activeColor: 'red' });
    setState({ playCard });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'הנחת שינוי צבע' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ביטול' }));
    expect(playCard).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape and restores focus to the card', async () => {
    situation({ hand: [colorChange], discardTop: red9, activeColor: 'red' });
    const { user } = renderApp();

    const card = screen.getByRole('button', { name: 'הנחת שינוי צבע' });
    await user.click(card);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(card).toHaveFocus();
  });

  it('traps focus inside the dialog', async () => {
    situation({ hand: [colorChange], discardTop: red9, activeColor: 'red' });
    const { user } = renderApp();
    await user.click(screen.getByRole('button', { name: 'הנחת שינוי צבע' }));

    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 8; i += 1) {
      await user.keyboard('{Tab}');
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});

describe('Taki mode', () => {
  it('announces an open sequence and offers an explicit close control', async () => {
    const closeTaki = vi.fn();
    situation({
      hand: [red5, blue2],
      discardTop: redTaki,
      activeColor: 'red',
      takiMode: { color: 'red' },
    });
    setState({ closeTaki });
    const { user } = renderApp();

    expect(screen.getByText('רצף טאקי פתוח — אדום')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'סגירת טאקי' }));
    expect(closeTaki).toHaveBeenCalled();
  });

  it('only enables cards of the sequence colour, and never wild cards', () => {
    situation({
      hand: [red5, blue5, colorChange, superTaki],
      discardTop: redTaki,
      activeColor: 'red',
      takiMode: { color: 'red' },
    });
    renderApp();

    expect(screen.getByRole('button', { name: 'הנחת אדום 5' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'הנחת כחול 5' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'הנחת שינוי צבע' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'הנחת סופר טאקי' })).toBeDisabled();
  });

  it('hides the close control from the player who does not own the sequence', () => {
    situation({
      hand: [red5],
      discardTop: redTaki,
      activeColor: 'red',
      myTurn: false,
      takiMode: { color: 'red' },
    });
    setState({ localPlayerId: GUEST_ID, lobby: lobbyFixture({ phase: 'inGame' }) });
    renderApp();
    expect(screen.queryByRole('button', { name: 'סגירת טאקי' })).not.toBeInTheDocument();
  });
});

describe('outstanding Plus', () => {
  it('tells the player another card is owed', () => {
    situation({ hand: [red5, blue2], discardTop: red9, activeColor: 'red', pendingPlus: true });
    renderApp();
    expect(screen.getByText('הונח פלוס — חייבים להניח עוד קלף.')).toBeInTheDocument();
  });
});

describe('game log', () => {
  it('lists public events without exposing hands', () => {
    enterGame();
    setState({
      feed: [
        { id: 1, event: { type: 'gameStarted', firstPlayerId: HOST_ID, activeColor: 'red' } },
        {
          id: 2,
          event: { type: 'cardPlayed', playerId: GUEST_ID, card: blue5, resultingColor: 'blue' },
        },
        { id: 3, event: { type: 'cardDrawn', playerId: HOST_ID, count: 1 } },
      ],
    });
    renderApp();

    expect(screen.getByText('הסבב מתחיל. הצבע: אדום.')).toBeInTheDocument();
    expect(screen.getByText('אלי הניח/ה כחול 5.')).toBeInTheDocument();
    expect(screen.getByText('דנה משך/ה קלף.')).toBeInTheDocument();
  });

  it('says so when nothing has happened yet', () => {
    enterGame();
    renderApp();
    expect(screen.getByText('עוד לא קרה דבר.')).toBeInTheDocument();
  });
});

describe('rejected moves', () => {
  it('explains the rejection and can be dismissed', async () => {
    enterGame();
    setState({ rejection: { code: 'illegalCard', nonce: 1 } });
    const { user } = renderApp();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('הקלף לא מתאים לצבע ולא לסמל.');
    await user.click(within(alert).getByRole('button', { name: 'סגירה' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the required colour for a wrong Taki colour', () => {
    situation({
      hand: [red5],
      discardTop: redTaki,
      activeColor: 'red',
      takiMode: { color: 'red' },
    });
    setState({ rejection: { code: 'wrongTakiColor', nonce: 2 } });
    renderApp();
    expect(screen.getByRole('alert')).toHaveTextContent('רק קלפים בצבע אדום');
  });
});

describe('in-game help and leaving', () => {
  it('opens a compact rules drawer', async () => {
    enterGame();
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'חוקים בקצרה' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('חוקים בקצרה');
    expect(within(dialog).getByRole('heading', { name: 'רצפי טאקי' })).toBeInTheDocument();
    // The compact drawer omits the reference sections.
    expect(within(dialog).queryByRole('heading', { name: 'החבילה (110 קלפים)' })).not.toBeInTheDocument();
  });

  it('confirms before leaving a game', async () => {
    const leaveRoom = vi.fn();
    enterGame();
    setState({ leaveRoom });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'יציאה' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('יציאה תסיים את המשחק לכולם');
    await user.click(within(dialog).getByRole('button', { name: 'יציאה' }));
    expect(leaveRoom).toHaveBeenCalled();
  });

  it('waits politely before the first snapshot arrives', () => {
    setState({ screen: 'game', role: 'client', phase: 'connected', publicState: null });
    renderApp();
    expect(screen.getByRole('status')).toHaveTextContent('ממתינים לשולחן…');
  });
});
