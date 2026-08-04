import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { GUEST_ID, HOST_ID, gameFixture, lobbyFixture, renderApp, resetStore, setState } from './helpers.tsx';

beforeEach(resetStore);

function enterGameOver(patch: Parameters<typeof setState>[0] = {}): void {
  const fixture = gameFixture();
  setState({
    screen: 'over',
    role: 'host',
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

    await user.click(within(dialog).getByRole('button', { name: 'סגירת החדר לכולם' }));
    expect(leaveRoom).toHaveBeenCalled();
  });

  it('marks the winner in words as well as with a tint', () => {
    enterGameOver();
    renderApp();
    const winnerRow = screen.getByRole('table').querySelector('.standings__winner');
    expect(winnerRow).not.toBeNull();
    expect(winnerRow).toHaveTextContent('מנצח/ת');
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
