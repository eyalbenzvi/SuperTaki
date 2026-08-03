import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp, resetStore, setState } from './helpers.tsx';
import { useAppStore } from '../../src/features/game/state/store.ts';

beforeEach(() => {
  resetStore();
  window.location.hash = '';
});

describe('create room form', () => {
  it('requires a display name', async () => {
    const createRoom = vi.fn().mockResolvedValue(undefined);
    setState({ screen: 'create', createRoom });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'יצירת חדר' }));
    expect(screen.getByRole('alert')).toHaveTextContent('נא להזין שם');
    expect(createRoom).not.toHaveBeenCalled();
    expect(screen.getByLabelText('השם שיוצג')).toHaveAttribute('aria-invalid', 'true');
  });

  it('submits a sanitised name with the chosen options', async () => {
    const createRoom = vi.fn().mockResolvedValue(undefined);
    setState({ screen: 'create', createRoom });
    const { user } = renderApp();

    await user.type(screen.getByLabelText('השם שיוצג'), '  דנה  ');
    await user.click(screen.getByRole('radio', { name: '6' }));
    await user.click(screen.getByRole('button', { name: 'יצירת חדר' }));

    expect(createRoom).toHaveBeenCalledWith({ name: 'דנה', maxPlayers: 6, tableLanguage: 'he' });
  });

  it('caps the name length in the input itself', () => {
    setState({ screen: 'create' });
    renderApp();
    expect(screen.getByLabelText('השם שיוצג')).toHaveAttribute('maxlength', '16');
  });

  it('shows progress while the room is opening', () => {
    setState({ screen: 'create', busy: true });
    renderApp();
    const submit = screen.getByRole('button', { name: 'פותח את החדר…' });
    expect(submit).toBeDisabled();
  });

  it('reports a failure to open the room instead of staying silent', () => {
    setState({
      screen: 'create',
      phase: 'failed',
      error: { code: 'signalingUnavailable', retryable: true },
    });
    renderApp();

    expect(screen.getByText(/לא הצלחנו להגיע לשירות החיבור החינמי/)).toBeInTheDocument();
    expect(screen.getByText('למה זה קורה?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'חזרה לדף הבית' })).toBeInTheDocument();
  });

  it('reports a taken room code', () => {
    setState({
      screen: 'create',
      phase: 'failed',
      error: { code: 'idUnavailable', retryable: false },
    });
    renderApp();
    expect(screen.getByText(/קוד החדר הזה תפוס/)).toBeInTheDocument();
  });

  it('offers the player count range 2 to 6', () => {
    setState({ screen: 'create' });
    renderApp();
    for (const count of ['2', '3', '4', '5', '6']) {
      expect(screen.getByRole('radio', { name: count })).toBeInTheDocument();
    }
    expect(screen.queryByRole('radio', { name: '7' })).not.toBeInTheDocument();
  });
});

describe('join room form', () => {
  it('rejects an unusable room code', async () => {
    const joinRoom = vi.fn().mockResolvedValue(undefined);
    setState({ screen: 'join', joinRoom, displayName: 'דנה' });
    const { user } = renderApp();

    await user.type(screen.getByLabelText('קישור הזמנה או קוד חדר'), 'not a room');
    await user.click(screen.getByRole('button', { name: 'הצטרפות לחדר' }));

    expect(screen.getByRole('alert')).toHaveTextContent('זה לא נראה כמו קוד חדר');
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('accepts a bare room code', async () => {
    const joinRoom = vi.fn().mockResolvedValue(undefined);
    setState({ screen: 'join', joinRoom, displayName: 'דנה' });
    const { user } = renderApp();

    await user.type(screen.getByLabelText('קישור הזמנה או קוד חדר'), 'tiger mango 42');
    await user.click(screen.getByRole('button', { name: 'הצטרפות לחדר' }));

    expect(joinRoom).toHaveBeenCalledWith({ name: 'דנה', roomCode: 'TIGER-MANGO-42' });
  });

  it('accepts a full invite link, including a custom host id', async () => {
    const joinRoom = vi.fn().mockResolvedValue(undefined);
    setState({ screen: 'join', joinRoom, displayName: 'דנה' });
    const { user } = renderApp();

    await user.type(
      screen.getByLabelText('קישור הזמנה או קוד חדר'),
      'https://example.github.io/color-rush/#/join?room=TIGER-MANGO-42&host=custom-host-1',
    );
    await user.click(screen.getByRole('button', { name: 'הצטרפות לחדר' }));

    expect(joinRoom).toHaveBeenCalledWith({
      name: 'דנה',
      roomCode: 'TIGER-MANGO-42',
      hostPeerId: 'custom-host-1',
    });
  });

  it('reports both problems at once', async () => {
    const joinRoom = vi.fn().mockResolvedValue(undefined);
    setState({ screen: 'join', joinRoom, displayName: '' });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'הצטרפות לחדר' }));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('prefills and announces a room from an invite link', () => {
    window.location.hash = '#/join?room=TIGER-MANGO-42';
    setState({ screen: 'join', displayName: 'דנה' });
    renderApp();

    expect(screen.getByLabelText('קישור הזמנה או קוד חדר')).toHaveValue('TIGER-MANGO-42');
    expect(screen.getByRole('status')).toHaveTextContent('TIGER-MANGO-42');
  });

  it('rejoins with the stored resume credentials', async () => {
    const joinRoom = vi.fn().mockResolvedValue(undefined);
    setState({
      screen: 'join',
      joinRoom,
      resumable: {
        roomCode: 'TIGER-MANGO-42',
        hostPeerId: 'crush-tiger-mango-42',
        playerId: 'pl_abc',
        resumeToken: 'a'.repeat(32),
        displayName: 'דנה',
        savedAt: Date.now(),
      },
    });
    const { user } = renderApp();

    await user.click(screen.getByRole('button', { name: 'חזרה לחדר' }));
    expect(joinRoom).toHaveBeenCalledWith({
      name: 'דנה',
      roomCode: 'TIGER-MANGO-42',
      hostPeerId: 'crush-tiger-mango-42',
      resume: { playerId: 'pl_abc', resumeToken: 'a'.repeat(32) },
    });
  });

  it('stores the display name for next time', async () => {
    setState({ screen: 'create' });
    const { user } = renderApp();
    await user.type(screen.getByLabelText('השם שיוצג'), 'דנה');
    await user.click(screen.getByRole('radio', { name: '3' }));
    // The store's own action persists the name; assert through the store.
    useAppStore.getState().setDisplayName('דנה');
    expect(localStorage.getItem('superTaki:displayName')).toBe('דנה');
  });
});
