import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { GUEST_ID, HOST_ID, gameFixture, lobbyFixture, renderApp, resetStore, setState } from './helpers.tsx';

beforeEach(resetStore);

function enterGameOver(patch: Parameters<typeof setState>[0] = {}): void {
  const fixture = gameFixture();
  setState({
    screen: 'over',
    inRoom: true,
    phase: 'connected',
    localPlayerId: HOST_ID,
    lobby: lobbyFixture({ phase: 'finished' }),
    publicState: {
      ...fixture.publicState,
      phase: 'finished',
      winnerId: GUEST_ID,
      currentPlayerId: null,
      players: [
        { id: HOST_ID, name: 'דנה', cardCount: 3 },
        { id: GUEST_ID, name: 'אלי', cardCount: 0 },
      ],
    },
    playAgain: { agreed: [], required: 2 },
    ...patch,
  });
}

describe('a round that ended with no winner', () => {
  it('says so, rather than naming one from nothing', () => {
    const fixture = gameFixture();
    setState({
      screen: 'over',
      inRoom: true,
      phase: 'connected',
      localPlayerId: HOST_ID,
      lobby: lobbyFixture({ phase: 'finished' }),
      publicState: {
        ...fixture.publicState,
        phase: 'finished',
        // No winner, and an explicit reason. Naming somebody anyway would be a
        // lie; leaving the line blank would read as a bug.
        winnerId: null,
        endReason: 'abandoned',
        currentPlayerId: null,
        players: [
          { id: HOST_ID, name: 'דנה', cardCount: 3 },
          { id: GUEST_ID, name: 'אלי', cardCount: 5 },
        ],
      },
      playAgain: { agreed: [], required: 2 },
    });
    renderApp();

    expect(screen.getByText('הסבב הסתיים בלי מנצח.')).toBeInTheDocument();
    // Everybody still appears with the hand they were holding: erasing a player
    // from the standings of a round they might have been winning is not a result.
    const table = screen.getByRole('table');
    expect(within(table).getByText('דנה')).toBeInTheDocument();
    expect(within(table).getByText('אלי')).toBeInTheDocument();
    expect(table.querySelector('.standings__winner')).toBeNull();
  });
});

describe('end of round', () => {
  it('names the winner and lists final standings', () => {
    enterGameOver();
    renderApp();

    expect(screen.getByRole('heading', { name: 'הסבב הסתיים' })).toBeInTheDocument();
    expect(screen.getByText('אלי ניצח/ה!')).toBeInTheDocument();

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    // Header plus two players, ordered by fewest cards left.
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('אלי');
    expect(rows[1]).toHaveTextContent('0');
    expect(rows[2]).toHaveTextContent('דנה');
    expect(rows[2]).toHaveTextContent('3');
  });

  it('congratulates the local winner directly', () => {
    const fixture = gameFixture();
    enterGameOver({
      publicState: {
        ...fixture.publicState,
        phase: 'finished',
        winnerId: HOST_ID,
        currentPlayerId: null,
        players: [
          { id: HOST_ID, name: 'דנה', cardCount: 0 },
          { id: GUEST_ID, name: 'אלי', cardCount: 4 },
        ],
      },
    });
    renderApp();
    expect(screen.getByText('ניצחת!')).toBeInTheDocument();
  });

  it('votes for another round and reports progress', async () => {
    const votePlayAgain = vi.fn();
    enterGameOver({ votePlayAgain });
    const { user } = renderApp();

    const button = screen.getByRole('button', { name: 'סבב נוסף' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.click(button);
    expect(votePlayAgain).toHaveBeenCalledWith(true);
    expect(screen.getByText('ממתינים לכולם: 0 מתוך 2 הסכימו.')).toBeInTheDocument();
  });

  it('lets a player withdraw their vote', async () => {
    const votePlayAgain = vi.fn();
    enterGameOver({ votePlayAgain, playAgain: { agreed: [HOST_ID], required: 2 } });
    const { user } = renderApp();

    const button = screen.getByRole('button', { name: 'סבב נוסף' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await user.click(button);
    expect(votePlayAgain).toHaveBeenCalledWith(false);
  });

  it('is honest about not saving anything', () => {
    enterGameOver();
    renderApp();
    expect(screen.getByText('שום דבר לא נשמר: סגירת החדר מוחקת את המשחק לחלוטין.')).toBeInTheDocument();
  });

  it('confirms before a host closes the room from here', async () => {
    const leaveRoom = vi.fn();
    enterGameOver({ leaveRoom });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'חזרה לדף הבית' }));
    // The round is over but the room is not: leaving takes the rematch with it,
    // which is why it is still confirmed rather than immediate.
    const dialog = screen.getByRole('dialog');
    expect(leaveRoom).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'יציאה' }));
    expect(leaveRoom).toHaveBeenCalled();
  });

  it('marks the winner in words as well as with a tint', () => {
    enterGameOver();
    renderApp();
    const winnerRow = screen.getByRole('table').querySelector('.standings__winner');
    expect(winnerRow).not.toBeNull();
    expect(winnerRow).toHaveTextContent('מנצח/ת');
  });

  /*
   * The evening, beside the round. A table that plays five rounds could not tell you
   * who was ahead: every round ended, the standings were shown, and the score of
   * everything before it was nowhere.
   */
  it('shows the running score once somebody has won something', () => {
    enterGameOver({
      lobby: lobbyFixture({
        phase: 'finished',
        players: [
          { id: HOST_ID, name: 'דנה', isCreator: true, health: 'connected', seat: 0, wins: 1 },
          { id: GUEST_ID, name: 'אלי', isCreator: false, health: 'connected', seat: 1, wins: 3 },
        ],
      }),
    });
    renderApp();

    expect(screen.getByText('ניקוד מצטבר')).toBeInTheDocument();
    const tables = screen.getAllByRole('table');
    // Two tables: this round, then the room's total.
    expect(tables).toHaveLength(2);
    const totals = tables[1] as HTMLElement;
    expect(within(totals).getByRole('columnheader', { name: 'סבבים שנוצחו' })).toBeInTheDocument();
    const rows = within(totals).getAllByRole('row');
    // Most wins first, whatever this round did.
    expect(rows[1]).toHaveTextContent('אלי');
    expect(rows[1]).toHaveTextContent('3');
    expect(rows[2]).toHaveTextContent('דנה');
    expect(rows[2]).toHaveTextContent('1');
    // And the one promise worth making about it, where the score is.
    expect(
      screen.getByText('מספר הסבבים שכל שחקן ניצח מאז שנפתח החדר. סגירת החדר מאפסת את הניקוד.'),
    ).toBeInTheDocument();
  });

  it('leaves the score out entirely before anybody has won a round', () => {
    // The first round of an evening: a column of noughts says nothing and pushes
    // the two decisions this screen exists for further down the page.
    enterGameOver();
    renderApp();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.queryByText('ניקוד מצטבר')).not.toBeInTheDocument();
  });

  /*
   * Ranking by cards left is the wrong answer in a stairs round: a player one step
   * from the end can be holding more cards than somebody who has emptied nothing.
   */
  it('ranks a stairs round by the staircase, and shows how far each seat got', () => {
    const fixture = gameFixture();
    enterGameOver({
      publicState: {
        ...fixture.publicState,
        phase: 'finished',
        mode: 'stairs',
        winnerId: GUEST_ID,
        currentPlayerId: null,
        players: [
          { id: HOST_ID, name: 'דנה', cardCount: 2, stairsStep: 6 },
          { id: GUEST_ID, name: 'אלי', cardCount: 0, stairsStep: 8 },
        ],
      },
    });
    renderApp();

    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'ידיים שהושלמו' })).toBeInTheDocument();
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('אלי');
    expect(rows[1]).toHaveTextContent('8/8');
    expect(rows[2]).toHaveTextContent('דנה');
    expect(rows[2]).toHaveTextContent('6/8');
  });

  it('does not offer a staircase column for a classic round', () => {
    enterGameOver();
    renderApp();
    expect(screen.queryByRole('columnheader', { name: 'ידיים שהושלמו' })).not.toBeInTheDocument();
  });

  it('keeps the standings numeric, with the unit in the header', () => {
    enterGameOver();
    renderApp();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'קלפים שנשארו' })).toBeInTheDocument();
    expect([...table.querySelectorAll('.standings__count')].map((cell) => cell.textContent)).toEqual([
      '0',
      '3',
    ]);
  });
});
