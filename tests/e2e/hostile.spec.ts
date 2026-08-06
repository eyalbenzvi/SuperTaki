/**
 * The table, played badly on purpose.
 *
 * Everything here is a thing a real player does and a developer does not: tapping
 * the control that is refusing them, tapping during an animation, rotating the
 * phone mid-flight, changing language in the middle of a round, walking away at
 * the moment the round ends. Two of these were written after they found bugs.
 */
import { expect, test, type Page } from '@playwright/test';
import { awaitSettled, canDrawFrom, createRoom, joinRoom, onTurn, openApp } from './helpers.ts';

/**
 * How many passes in a row have to find nothing to do before the table counts as
 * stuck, and how long to wait between them.
 *
 * A pass that clicks nothing is the normal state of a live table, not a stalled
 * one: a card is in flight, the turn is crossing between two pages, the win hold
 * is running, the other page has not painted yet. Both round-driving tests used
 * to leave their loop on the *first* such pass and then assert the standings were
 * up — so a round that was merely mid-beat failed as a round that never finished.
 * That is the whole of the `hostile.spec` flake: it failed on desktop and mobile
 * in one run and passed on another run of the same commit, which is what a
 * too-eager exit looks like on a busy machine.
 */
const IDLE_PASSES_BEFORE_STUCK = 4;
const IDLE_PAUSE_MS = 400;

/** Whether the standings are up on this page. */
async function roundFinished(page: Page): Promise<boolean> {
  return (await page.getByRole('heading', { name: 'Round finished' }).count()) > 0;
}

/**
 * Plays a two-player round out through the UI, tapping whatever is legal on
 * whichever page owes a move. Returns whether the round actually reached its end.
 *
 * `budgetMs` is a ceiling, not a cost: the loop leaves the moment the standings
 * appear, so raising it slows nothing down and only stops a slow machine being
 * reported as a broken one.
 */
async function playRoundOut(host: Page, guest: Page, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let idlePasses = 0;

  while (Date.now() < deadline) {
    if (await roundFinished(host)) {
      return true;
    }

    let acted = false;
    for (const page of [host, guest]) {
      await page.bringToFront();
      await awaitSettled(page);
      for (const name of [/Last card!/, 'Let it through', 'Close Taki', /^Take \d+ cards?$/]) {
        const button = page.getByRole('button', { name });
        if (await button.isVisible().catch(() => false)) {
          await button.click().catch(() => undefined);
          acted = true;
        }
      }
      if (!(await onTurn(page))) {
        continue;
      }
      const playable = page.locator('.hand .card--playable').first();
      if (await playable.count()) {
        await playable.click().catch(() => undefined);
        const picker = page.getByRole('dialog');
        if (await picker.isVisible().catch(() => false)) {
          await picker.getByRole('button').first().click();
        }
        acted = true;
      } else if (await canDrawFrom(page)) {
        await page
          .locator('.pile button.card--back')
          .click()
          .catch(() => undefined);
        acted = true;
      }
    }

    if (acted) {
      idlePasses = 0;
      continue;
    }
    idlePasses += 1;
    if (idlePasses >= IDLE_PASSES_BEFORE_STUCK) {
      break;
    }
    // Give the table the moment it was in the middle of before looking again.
    await host.waitForTimeout(IDLE_PAUSE_MS);
  }

  return await roundFinished(host);
}

async function seat(host: Page, guest: Page): Promise<void> {
  await openApp(host, '/');
  const code = await createRoom(host, 'Dana', 2);
  await openApp(guest, '/');
  await joinRoom(guest, 'Eli', code);
  await expect(host.getByText('2 of 2 players')).toBeVisible();
  await host.bringToFront();
  await host.getByRole('button', { name: 'Start game' }).click();
  await expect(host.locator('.hand .card')).toHaveCount(8);
  await expect(guest.locator('.hand .card')).toHaveCount(8);
}

test('hammering a blocked draw pile changes nothing and always explains itself', async ({ context }) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  await seat(host, guest);

  const pile = guest.getByRole('button', { name: /Draw pile, \d+ cards/ });
  const before = await guest.locator('.hand .card').count();
  // `force`, because Playwright's actionability check honours `aria-disabled` and
  // refuses the click — which is itself the answer to a question the plan left
  // open. A finger does not consult the accessibility tree, so a real player can
  // and does tap this, and that is the path being tested.
  for (let i = 0; i < 8; i += 1) {
    await pile.click({ force: true });
  }
  await expect(guest.locator('.hand .card')).toHaveCount(before);
  await expect(pile).toHaveAttribute('aria-disabled', 'true');
  // The reason is reachable, and the prompt it used to hide is still there.
  const described = await pile.getAttribute('aria-describedby');
  expect(described).not.toBeNull();
  await expect(guest.locator(`#${described ?? ''}`)).toHaveCount(1);
  await expect(guest.locator('.game__action .callout')).toHaveCount(2);
});

test('tapping unplayable cards repeatedly never plays one', async ({ context }) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  await seat(host, guest);

  const before = await guest.locator('.hand .card').count();
  const cards = guest.locator('.hand .card');
  for (let i = 0; i < Math.min(5, before); i += 1) {
    await cards.nth(i).click({ force: true });
  }
  await expect(guest.locator('.hand .card')).toHaveCount(before);
});

test('playing fast leaves no residue and the table stays consistent', async ({ context }) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  await seat(host, guest);

  for (let move = 0; move < 10; move += 1) {
    for (const page of [host, guest]) {
      await page.bringToFront();
      await awaitSettled(page);
      if (!(await onTurn(page))) {
        continue;
      }
      const playable = page.locator('.hand .card--playable').first();
      if (await playable.count()) {
        await playable.click().catch(() => undefined);
        const picker = page.getByRole('dialog');
        if (await picker.isVisible().catch(() => false)) {
          await picker.getByRole('button').first().click();
        }
      } else if (await canDrawFrom(page)) {
        await page
          .locator('.pile button.card--back')
          .click()
          .catch(() => undefined);
      }
    }
  }

  /*
   * To the front before measuring: Chromium freezes animations in a background
   * tab, so a clone on a hidden page has not finished rather than leaked. It
   * resumes and clears when the tab comes back, which is the correct behaviour and
   * would otherwise read here as a leak.
   */
  await host.bringToFront();
  await host.waitForTimeout(1200);
  const state = await host.evaluate(() => ({
    clones: document.querySelectorAll('.flight-layer__card').length,
    pulses: document.querySelectorAll('.flight-layer__pulse').length,
    handCards: document.querySelectorAll('.hand .card').length,
    slots: document.querySelectorAll('.hand__slot').length,
  }));
  expect(state.clones).toBe(0);
  expect(state.pulses).toBe(0);
  // One card per slot, always.
  expect(state.handCards).toBe(state.slots);
});

test('rotating and resizing mid-animation strands nothing', async ({ context }) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  await host.setViewportSize({ width: 390, height: 700 });
  await seat(host, guest);

  await host.bringToFront();
  if (await onTurn(host)) {
    const playable = host.locator('.hand .card--playable').first();
    if (await playable.count()) {
      await playable.click();
      const picker = host.getByRole('dialog');
      if (await picker.isVisible().catch(() => false)) {
        await picker.getByRole('button').first().click();
      }
    }
  }
  // Straight into the middle of the flight.
  await host.setViewportSize({ width: 700, height: 390 });
  await host.waitForTimeout(120);
  await host.setViewportSize({ width: 320, height: 568 });
  await host.waitForTimeout(1200);

  const report = await host.evaluate(() => {
    const cards = [...document.querySelectorAll('.hand .card')].map((c) => c.getBoundingClientRect());
    return {
      clones: document.querySelectorAll('.flight-layer__card').length,
      offscreen: cards.filter(
        (c) =>
          c.top < -0.5 ||
          c.bottom > window.innerHeight + 0.5 ||
          c.left < -0.5 ||
          c.right > window.innerWidth + 0.5,
      ).length,
    };
  });
  expect(report.clones).toBe(0);
  expect(report.offscreen).toBe(0);
});

test('the winner always reaches the standings', async ({ context }) => {
  // Driving a whole round to its end plus the post-round assertions can run past
  // the 45 s default; a round's length is nondeterministic, so the headroom has to
  // be generous rather than tuned to the median. QA caught this racing its own
  // 45 s ceiling — and then it raced the replacement, on the mobile viewport, on a
  // machine running the whole suite about a quarter slower than the day the number
  // was chosen. A round here is a hundred-odd DOM round trips; the budget is now
  // generous enough that exceeding it means something is stuck rather than slow.
  test.setTimeout(300_000);
  const host = await context.newPage();
  const guest = await context.newPage();
  await seat(host, guest);

  // Drive to the end of the round, bounded well inside the test's own timeout.
  const played = await playRoundOut(host, guest, 240_000);
  expect(played, 'the round never reached its end, so the standings were never due').toBe(true);

  // Whoever won, both players end up on the standings — after the hold, not never.
  await expect(host.getByRole('heading', { name: 'Round finished' })).toBeVisible({ timeout: 15_000 });
  await expect(guest.getByRole('heading', { name: 'Round finished' })).toBeVisible({ timeout: 15_000 });
});

test('keyboard-only play reaches the hand and the pile', async ({ context }) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  await seat(host, guest);
  await host.bringToFront();

  const reached = new Set<string>();
  for (let i = 0; i < 40; i += 1) {
    await host.keyboard.press('Tab');
    const what = await host.evaluate(() => {
      const el = document.activeElement;
      if (!el) return 'none';
      if (el.closest('.flight-layer')) return 'CLONE';
      if (el.closest('.hand')) return 'hand';
      if (el.closest('.pile')) return 'pile';
      return el.tagName.toLowerCase();
    });
    reached.add(what);
  }
  expect(reached.has('hand')).toBe(true);
  expect(reached.has('pile')).toBe(true);
  // A clone must never be a tab stop: it is inside an aria-hidden layer and
  // would announce nothing.
  expect(reached.has('CLONE')).toBe(false);
});

test('switching language mid-round does not drag the hand across the screen', async ({ context }) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  await host.setViewportSize({ width: 390, height: 700 });
  await seat(host, guest);
  await host.bringToFront();

  const slotLefts = async (): Promise<number[]> =>
    host.evaluate(() =>
      [...document.querySelectorAll('.hand__slot')].map((s) => Math.round(s.getBoundingClientRect().left)),
    );
  const inEnglish = await slotLefts();

  // Hebrew mirrors the row wholesale. Nothing about the hand's own box changes and
  // neither does the set of cards, so this used to go unnoticed — and the next card
  // played animated every card hundreds of pixels sideways.
  await host.locator('.topbar__controls button').last().click();
  await host.getByRole('radio', { name: 'עברית' }).click();
  await host.getByRole('dialog').getByRole('button').last().click();
  await expect(host.locator('html')).toHaveAttribute('dir', 'rtl');
  const inHebrew = await slotLefts();
  expect(inHebrew).not.toEqual(inEnglish);

  if (await onTurn(host)) {
    await awaitSettled(host);
    const playable = host.locator('.hand .card--playable').first();
    if (await playable.count()) {
      await playable.click();
      const picker = host.getByRole('dialog');
      if (await picker.isVisible().catch(() => false)) {
        await picker.getByRole('button').first().click();
      }
    }
  }

  // Sampled while the reflow would be animating: no card may be off screen, and
  // none may be travelling from the mirrored position it used to hold.
  for (let sample = 0; sample < 6; sample += 1) {
    const offscreen = await host.evaluate(() => {
      const cards = [...document.querySelectorAll('.hand .card')].map((c) => c.getBoundingClientRect());
      return cards.filter(
        (c) => c.left < -0.5 || c.right > window.innerWidth + 0.5 || c.bottom > window.innerHeight + 0.5,
      ).length;
    });
    expect(offscreen, `sample ${String(sample)}`).toBe(0);
    await host.waitForTimeout(40);
  }
});

test('leaving during the win hold does not drag the player to the standings', async ({ context }) => {
  /*
   * Same reason as the standings test above: a full round plus the leave-and-settle
   * assertions do not fit inside the 45 s default with any margin. The budget for
   * the round itself used to be a minute — half of this test's whole timeout, and
   * well under what a long round takes on the mobile viewport, which is where it
   * failed. It matches the other round test now; the loop still leaves the moment
   * the standings appear, so the ceiling costs nothing when the round is quick.
   */
  test.setTimeout(300_000);
  const host = await context.newPage();
  const guest = await context.newPage();
  await seat(host, guest);

  const played = await playRoundOut(host, guest, 240_000);
  expect(played, 'the round never reached its end, so the win hold was never due').toBe(true);

  await expect(host.getByRole('heading', { name: 'Round finished' })).toBeVisible({ timeout: 15_000 });
  // Once the standings are up, going home must stay home.
  await host.getByRole('button', { name: /Back to home|Home/ }).click();
  const confirm = host.getByRole('dialog');
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.getByRole('button', { name: /Leave|Close the room/ }).click();
  }
  await host.waitForTimeout(1500);
  await expect(host.getByRole('heading', { name: 'Round finished' })).toHaveCount(0);
});
