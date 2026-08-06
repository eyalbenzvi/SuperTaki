import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { openSettings, renderApp, resetStore, setState } from './helpers.tsx';
import { useAppStore } from '../../src/features/game/state/store.ts';

beforeEach(resetStore);

describe('landing screen', () => {
  it('renders the wordmark and the two entry points', () => {
    renderApp();
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('סופר טאקי');
    expect(screen.getByRole('button', { name: 'פתיחת משחק' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'הצטרפות למשחק' })).toBeInTheDocument();
  });

  it('shows nothing beyond the two entry points and settings', () => {
    renderApp();
    // Create, join, and the one control that holds every preference.
    expect(
      screen.getAllByRole('button').map((node) => node.getAttribute('aria-label') ?? node.textContent),
    ).toEqual(['הגדרות', 'פתיחת משחק', 'הצטרפות למשחק']);
  });

  it('switches language and document direction', async () => {
    const { user } = renderApp();
    await openSettings(user);
    await user.click(screen.getByRole('radio', { name: 'English' }));

    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('button', { name: 'Create game' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'עברית' }));
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('switches theme on the document root', async () => {
    const { user } = renderApp();
    await openSettings(user);
    await user.click(screen.getByRole('radio', { name: 'כהה' }));
    expect(document.documentElement.dataset.theme).toBe('dark');

    await user.click(screen.getByRole('radio', { name: 'בהיר' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('closes the settings sheet on Escape, leaving the choice applied', async () => {
    const { user } = renderApp();
    await openSettings(user);
    await user.click(screen.getByRole('radio', { name: 'כהה' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('moves between language options with the arrow keys', async () => {
    const { user } = renderApp();
    await openSettings(user);
    const hebrew = screen.getByRole('radio', { name: 'עברית' });
    hebrew.focus();
    await user.keyboard('{ArrowRight}');
    expect(useAppStore.getState().language).toBe('en');
  });

  it('jumps to the ends of a segmented control with Home and End', async () => {
    const { user } = renderApp();
    await openSettings(user);
    screen.getByRole('radio', { name: 'לפי המערכת' }).focus();
    await user.keyboard('{End}');
    expect(useAppStore.getState().theme).toBe('dark');
    await user.keyboard('{Home}');
    expect(useAppStore.getState().theme).toBe('system');
  });

  it('navigates to the create screen', async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole('button', { name: 'פתיחת משחק' }));
    expect(screen.getByRole('heading', { name: 'פתיחת משחק' })).toBeInTheDocument();
  });

  it('navigates to the join screen', async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole('button', { name: 'הצטרפות למשחק' }));
    expect(screen.getByRole('heading', { name: 'הצטרפות למשחק' })).toBeInTheDocument();
  });

  it('offers to rejoin a stored room', async () => {
    setState({
      resumable: {
        roomCode: '482913',
        playerId: 'pl_abc',
        resumeToken: 'a'.repeat(32),
        displayName: 'דנה',
        savedAt: Date.now(),
      },
    });
    const { user } = renderApp();

    const notice = screen.getByText(/המכשיר הזה היה בחדר/);
    expect(notice).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'להתחיל מחדש' }));
    expect(screen.queryByText(/המכשיר הזה היה בחדר/)).not.toBeInTheDocument();
  });

  it('exposes a skip link as the first focus stop', () => {
    renderApp();
    const link = screen.getByRole('link', { name: 'דלג לתוכן הראשי' });
    expect(link).toHaveAttribute('href', '#main');
  });

  it('labels the settings controls', async () => {
    const { user } = renderApp();
    const dialog = await openSettings(user);
    expect(within(dialog).getByRole('radiogroup', { name: 'שפה' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radiogroup', { name: 'ערכת צבעים' })).toBeInTheDocument();
  });

  it('explains what the game is to somebody who has never seen it', () => {
    renderApp();
    expect(screen.getByRole('heading', { name: 'איך זה עובד' })).toBeInTheDocument();
    expect(screen.getByText('שחקן אחד פותח חדר.')).toBeInTheDocument();
  });

  it('keeps the leave control off the screen outside a room', () => {
    renderApp();
    expect(screen.queryByRole('button', { name: 'יציאה' })).not.toBeInTheDocument();
  });
});
