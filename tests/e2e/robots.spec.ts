import { expect, test } from '@playwright/test';
import { awaitSettled, createRoom, openApp, takeAnyTurn } from './helpers.ts';

/**
 * A robot at the table, driven through the real UI on one page.
 *
 * This is the only test in the suite that plays a game without a second page,
 * which is the point: a robot is what makes a table of one a game. Everything
 * below the button is production code — the room's authoritative path, the same
 * engine, the same protocol — and the assertions are about what a player actually
 * sees: a seat marked as a robot, and a hand that empties without anybody touching
 * it.
 */
/**
 * A round's length varies enormously — the 116-card deck deals big hands and every
 * +2 run makes them bigger — so the budget is the clock, not a step count, and the
 * test's own timeout has to sit outside it.
 *
 * The same eight minutes the two-player round gets, and for the same reason: a
 * budget that fits the average round fails the long ones for nothing. Observed here
 * at 3.5–5.5 minutes, where the human plays the first legal card every time and the
 * robot plays properly.
 */
const ROUND_BUDGET_MS = 8 * 60 * 1000;

test.describe('a table with a robot in it', () => {
  test('seats a robot, plays a round with it, and lets it be removed again', async ({ page }, testInfo) => {
    test.setTimeout(ROUND_BUDGET_MS + 120_000);
    /*
     * Once is enough, for the same reason the two-player round runs once: nothing
     * about a robot's play depends on the viewport, and this is a long test.
     */
    test.skip(testInfo.project.name !== 'desktop', 'a round of play is viewport-independent');
    await openApp(page, '/');
    await createRoom(page, 'Dana', 2);

    // One player, and no game to start.
    await expect(page.getByRole('button', { name: 'Start game' })).toBeDisabled();

    await page.getByRole('button', { name: 'Add a robot' }).click();
    await expect(page.getByText('2 of 2 players')).toBeVisible();
    const roster = page.locator('.player-list__item').nth(1);
    await expect(roster).toContainText('Robot');
    await expect(roster.getByText('Robot', { exact: true })).toBeVisible();
    // The table is full, so the offer is withdrawn rather than left to fail.
    await expect(page.getByRole('button', { name: 'Add a robot' })).toBeDisabled();

    // It can be taken off the table as easily as it was put on.
    await page
      .locator('.player-list__item')
      .nth(1)
      .getByRole('button', { name: /Remove/ })
      .click();
    await page.getByRole('button', { name: 'Remove player' }).click();
    await expect(page.getByText('1 of 2 players')).toBeVisible();

    await page.getByRole('button', { name: 'Add a robot' }).click();
    await expect(page.getByRole('button', { name: 'Start game' })).toBeEnabled();
    await page.getByRole('button', { name: 'Start game' }).click();

    // The robot is at the table, named and marked, and it is holding cards.
    const seat = page.locator('.seat').first();
    await expect(seat).toContainText('Robot');
    await expect(seat).toContainText('cards');

    /*
     * Now play. The human plays the first legal card each time; the robot answers on
     * its own, from inside the room, with no help from this test. The round is bounded
     * by the clock rather than by a step count — how long a Taki round runs varies
     * enormously — and the assertion is that it *ends*.
     */
    const deadline = Date.now() + ROUND_BUDGET_MS;
    let moved = false;
    while (Date.now() < deadline) {
      if (
        await page
          .locator('.standings')
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        break;
      }
      // A hand of one has to be declared, or the robot calls it out and it is four
      // cards back.
      const declare = page.getByRole('button', { name: /Last card!/ });
      if (await declare.isVisible().catch(() => false)) {
        await declare.click();
        continue;
      }
      const breakIt = page.getByRole('button', { name: 'Let it through' });
      if (await breakIt.isVisible().catch(() => false)) {
        await breakIt.click();
        continue;
      }
      if (await takeAnyTurn(page)) {
        moved = true;
        continue;
      }
      // Not our turn: the robot owes the move, so wait for it to make one.
      await awaitSettled(page);
      await page.waitForTimeout(400);
    }

    expect(moved, 'the human seat never got a turn').toBe(true);
    // Somebody won, and the round reached its end without a second player anywhere.
    await expect(page.locator('.standings').first()).toBeVisible({ timeout: 30_000 });
  });
});
