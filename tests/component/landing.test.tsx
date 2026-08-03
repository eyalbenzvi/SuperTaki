import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderApp, resetStore, setState } from './helpers.tsx';
import { useAppStore } from '../../src/features/game/state/store.ts';

beforeEach(resetStore);

describe('landing screen', () => {
  it('renders the Hebrew title and the three entry points', () => {
    renderApp();
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('קולור ראש');
    expect(screen.getByRole('button', { name: 'פתיחת משחק' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'הצטרפות למשחק' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'איך משחקים' })).toBeInTheDocument();
  });

  it('states the connectivity limitation and privacy position up front', () => {
    renderApp();
    expect(screen.getByText(/השחקנים מתחברים ישירות/)).toBeInTheDocument();
    expect(screen.getByText(/אין חשבונות, אין שרתים/)).toBeInTheDocument();
    expect(screen.getByText(/פרויקט חובבים פרטי ולא רשמי/)).toBeInTheDocument();
  });

  it('switches language and document direction', async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole('radio', { name: 'English' }));

    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('button', { name: 'Create game' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'עברית' }));
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('switches theme on the document root', async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole('radio', { name: 'כהה' }));
    expect(document.documentElement.dataset.theme).toBe('dark');

    await user.click(screen.getByRole('radio', { name: 'בהיר' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('moves between language options with the arrow keys', async () => {
    const { user } = renderApp();
    const hebrew = screen.getByRole('radio', { name: 'עברית' });
    hebrew.focus();
    await user.keyboard('{ArrowRight}');
    expect(useAppStore.getState().language).toBe('en');
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

  it('opens the rules page and comes back to where it started', async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole('button', { name: 'איך משחקים' }));
    expect(screen.getByRole('heading', { name: 'איך משחקים קולור ראש' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'רצפי טאקי' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'חזרה' }));
    expect(screen.getByRole('button', { name: 'פתיחת משחק' })).toBeInTheDocument();
  });

  it('offers to rejoin a stored room', async () => {
    setState({
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

  it('labels the top bar controls', () => {
    renderApp();
    const bar = screen.getByRole('banner');
    expect(within(bar).getByRole('radiogroup', { name: 'שפה' })).toBeInTheDocument();
    expect(within(bar).getByRole('radiogroup', { name: 'ערכת צבעים' })).toBeInTheDocument();
  });
});
