import { expect, test, type Locator, type Page } from '@playwright/test';
import { BROADCAST, awaitSettled, createRoom, joinRoom, onTurn, openApp } from './helpers.ts';

/**
 * Plays a complete round through the UI.
 *
 * Both players act like simple bots: play the first legal card, close an open
 * Taki sequence when nothing else is legal, otherwise draw. This exercises long
 * chains of real host-validated commands — including special cards, Taki
 * sequences and draw-pile recycling — and ends on the game-over screen.
 *
 * Bounded by the clock rather than by a step count. How many steps a round
 * takes varies enormously — the 116-card deck deals big hands and every +2 run
 * makes them bigger — and a step count that fits the average round fails the
 * long ones for no reason. Time is what the test actually has to stay inside.
 */
const ROUND_BUDGET_MS = 8 * 60 * 1000;

/*
 * Both players are tabs in one browser, so one of them is always in the
 * background — and Chromium stops firing `requestAnimationFrame` there.
 * Playwright's actionability check waits on two animation frames, so a click on
 * a background tab would wait for ever even though the element is perfectly
 * clickable. Reading the DOM is unaffected, so only the clicks need this.
 */
async function clickInForeground(page: Page, locator: Locator): Promise<void> {
  await page.bringToFront();
  await locator.click();
}

async function takeOneAction(page: Page): Promise<boolean> {
  await page.bringToFront();
  await awaitSettled(page);

  /*
   * A hand of one is declared first, and out of turn if need be: without the
   * declaration the last card cannot win, so a bot that skipped it would draw a
   * two-card penalty every time it got close and the round would never end.
   */
  const declare = page.getByRole('button', { name: /Last card!/ });
  if (await declare.isVisible().catch(() => false)) {
    await clickInForeground(page, declare);
    return true;
  }

  // An open +3 suspends the turn order, so this comes before the turn check.
  const breakPrompt = page.getByRole('button', { name: 'Let it through' });
  if (await breakPrompt.isVisible().catch(() => false)) {
    await clickInForeground(page, breakPrompt);
    return true;
  }

  if (!(await onTurn(page))) {
    return false;
  }

  const playable = page.locator('.hand .card--playable').first();
  if (await playable.count()) {
    await clickInForeground(page, playable);
    const picker = page.getByRole('dialog');
    if (await picker.isVisible().catch(() => false)) {
      await picker.getByRole('button', { name: 'Green', exact: true }).click();
    }
    return true;
  }

  const closeTaki = page.getByRole('button', { name: 'Close Taki' });
  if (await closeTaki.isVisible().catch(() => false)) {
    await clickInForeground(page, closeTaki);
    return true;
  }

  // Paying an outstanding +2 run: the prompt's own button is the shortest path.
  const takeCards = page.getByRole('button', { name: /^Take \d+ cards?$/ });
  if (await takeCards.isVisible().catch(() => false)) {
    await clickInForeground(page, takeCards);
    return true;
  }

  const drawPile = page.getByRole('button', { name: /Draw pile, \d+ cards/ });
  if (await drawPile.isEnabled().catch(() => false)) {
    await clickInForeground(page, drawPile);
    return true;
  }
  return false;
}

test.describe('a complete round', () => {
  test.setTimeout(ROUND_BUDGET_MS + 120_000);

  test('plays to a winner and offers another round', async ({ context }, testInfo) => {
    /*
     * Once is enough. Nothing in a round of play depends on the viewport — the
     * layout tests cover that — and this is by far the longest test in the
     * suite, so running it twice buys no signal and doubles the wait.
     */
    test.skip(testInfo.project.name !== 'desktop', 'a round of play is viewport-independent');

    const host = await context.newPage();
    const guest = await context.newPage();

    await openApp(host, `/${BROADCAST}`);
    const roomCode = await createRoom(host, 'Dana', 2);
    await openApp(guest, `/${BROADCAST}`);
    await joinRoom(guest, 'Eli', roomCode);
    await expect(host.getByText('2 of 2 players')).toBeVisible();

    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.locator('.hand .card')).toHaveCount(8);

    const deadline = Date.now() + ROUND_BUDGET_MS;
    let finished = false;
    while (!finished && Date.now() < deadline) {
      const acted = (await takeOneAction(host)) || (await takeOneAction(guest));
      if (!acted) {
        // Give the transport a moment; a snapshot may still be in flight.
        await host.waitForTimeout(60);
      }
      finished = await host
        .getByRole('heading', { name: 'Round finished' })
        .isVisible()
        .catch(() => false);
    }

    expect(finished, 'the round did not reach a winner inside its time budget').toBe(true);
    await expect(host.getByRole('heading', { name: 'Final standings' })).toBeVisible();
    await expect(guest.getByRole('heading', { name: 'Round finished' })).toBeVisible();

    // Exactly one player finished with zero cards.
    const counts = await host.locator('.standings tbody tr td:last-child').allTextContents();
    expect(counts.filter((value) => value.trim() === '0')).toHaveLength(1);
    await expect(host.getByText('Nothing is saved')).toBeVisible();

    // A new round needs everyone to agree.
    await host.getByRole('button', { name: 'Play again' }).click();
    await expect(host.getByText('1 of 2 agreed')).toBeVisible();
    await guest.getByRole('button', { name: 'Play again' }).click();

    await expect(host.locator('.hand .card')).toHaveCount(8);
    await expect(guest.locator('.hand .card')).toHaveCount(8);
  });
});
