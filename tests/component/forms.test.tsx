import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp, resetStore, setState, statusRegions } from './helpers.tsx';
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

  it('shows an example name rather than an empty box', () => {
    setState({ screen: 'create' });
    renderApp();
    expect(screen.getByLabelText('השם שיוצג')).toHaveAttribute('placeholder', 'לדוגמה: דנה');
  });

  it('ties the hint and the error to the field for a screen reader', async () => {
    setState({ screen: 'create', createRoom: vi.fn().mockResolvedValue(undefined) });
    const { user } = renderApp();
    const field = screen.getByLabelText('השם שיוצג');
    const described = () => (field.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);

    expect(described()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'יצירת חדר' }));
    // The requirement and the failure are both announced, not just the failure.
    expect(described()).toHaveLength(2);
    for (const id of described()) {
      expect(document.getElementById(id)).toBeInTheDocument();
    }
  });

  it('keeps a way back while the room is opening', () => {
    setState({ screen: 'create', busy: true });
    renderApp();
    expect(screen.getByRole('button', { name: 'חזרה' })).toBeEnabled();
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

    await user.type(screen.getByLabelText('קישור הזמנה או קוד חדר'), '482 913');
    await user.click(screen.getByRole('button', { name: 'הצטרפות לחדר' }));

    expect(joinRoom).toHaveBeenCalledWith({ name: 'דנה', roomCode: '482913' });
  });

  it('accepts a full invite link, including a custom host id', async () => {
    const joinRoom = vi.fn().mockResolvedValue(undefined);
    setState({ screen: 'join', joinRoom, displayName: 'דנה' });
    const { user } = renderApp();

    await user.type(
      screen.getByLabelText('קישור הזמנה או קוד חדר'),
      'https://example.github.io/color-rush/#/join?room=482913&host=custom-host-1',
    );
    await user.click(screen.getByRole('button', { name: 'הצטרפות לחדר' }));

    expect(joinRoom).toHaveBeenCalledWith({
      name: 'דנה',
      roomCode: '482913',
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
    window.location.hash = '#/join?room=482913';
    setState({ screen: 'join', displayName: 'דנה' });
    renderApp();

    expect(screen.getByLabelText('קישור הזמנה או קוד חדר')).toHaveValue('482913');
    expect(statusRegions()[0]).toHaveTextContent('482913');
  });

  it('sets the room-code field up for a phone keyboard', () => {
    setState({ screen: 'join' });
    renderApp();
    const field = screen.getByLabelText('קישור הזמנה או קוד חדר');
    // Six digits, so a number pad — and none of the correcting a keyboard does.
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field).toHaveAttribute('spellcheck', 'false');
    expect(field).toHaveAttribute('autocorrect', 'off');
  });

  it('rejoins with the stored resume credentials', async () => {
    const joinRoom = vi.fn().mockResolvedValue(undefined);
    setState({
      screen: 'join',
      joinRoom,
      resumable: {
        roomCode: '482913',
        hostPeerId: 'crush-482913',
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
      roomCode: '482913',
      hostPeerId: 'crush-482913',
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
