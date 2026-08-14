import { expect, test, type Page } from '@playwright/test';
import { awaitSettled, canDrawFrom, createRoom, joinRoom, onTurn, openApp } from './helpers.ts';

/**
 * The table has to fit the screen it is on.
 *
 * Three reports drove this file, all of them "cut off": the pile panel sliced in
 * half by the bottom of its own region; in landscape, and with a big hand upright,
 * cards that were simply not on the screen; and — under a hand of forty — the
 * prompt squeezed to nothing, taking the Close Taki button with it. None of the
 * three is visible to a test that only asks whether an element exists, so these
 * measure geometry: every card inside the viewport, the panel inside the region
 * that holds it, and the whole prompt inside its own row.
 */

/**
 * Resizes and waits for the reflow before anything reads geometry.
 *
 * `setViewportSize` resolves before layout has settled, so measuring straight
 * afterwards samples mid-reflow numbers. That produced a failure about one run in
 * four — a flake in the very test whose job is catching layout regressions, which
 * is the worst place to have one.
 */
async function resize(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

interface Report {
  readonly cardsOutsideViewport: number;
  readonly panelOverflow: number;
  readonly handCards: number;
  readonly handRows: number;
  readonly promptHidden: number;
}

async function measure(page: Page): Promise<Report> {
  // A hovered card lifts clear of its neighbours, which would read as a second
  // row. The pointer is wherever the last click left it, so park it first.
  await page.mouse.move(0, 0);
  return page.evaluate(() => {
    const rect = (selector: string): DOMRect | null =>
      document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const cards = [...document.querySelectorAll('.hand .card')].map((card) => card.getBoundingClientRect());
    /*
     * Rows are counted from the *slots*, not the cards.
     *
     * A slot is the grid track and is never transformed; a card is lifted when it
     * is playable, and `getBoundingClientRect()` includes that transform. Counting
     * card tops conflated "raised" with "wrapped" — and did so intermittently,
     * because the lift arrives as a staggered wave, so the answer depended on how
     * far through it the measurement landed. The question this asks is about
     * layout, so it is asked of the thing that owns the layout.
     *
     * Cards are still what the viewport check below measures: a lifted card
     * clipping off the top of a short screen is a real risk, and it is the card
     * that would clip.
     */
    const slots = [...document.querySelectorAll('.hand .hand__slot')].map((slot) =>
      slot.getBoundingClientRect(),
    );
    const region = rect('.game__table');
    const panel = rect('.piles');
    /*
     * How much of the prompt is not on the screen.
     *
     * Its region scrolls as a last resort, so a clipped prompt is measured from the
     * region rather than from the callout: the callout keeps its full height and is
     * simply cut off by the region, so its own rectangle reports nothing wrong even
     * when none of it is visible. Anything below the fold of the page counts too —
     * the region can be pushed off the bottom instead of squeezed.
     */
    const prompt = document.querySelector<HTMLElement>('.game__action');
    const promptBox = rect('.game__action');
    const promptHidden = prompt
      ? Math.round(
          Math.max(0, prompt.scrollHeight - prompt.clientHeight) +
            Math.max(0, (promptBox?.bottom ?? 0) - window.innerHeight),
        )
      : 0;
    return {
      cardsOutsideViewport: cards.filter(
        (card) =>
          card.top < -0.5 ||
          card.bottom > window.innerHeight + 0.5 ||
          card.left < -0.5 ||
          card.right > window.innerWidth + 0.5,
      ).length,
      panelOverflow: region && panel ? Math.round(panel.height - region.height) : 0,
      promptHidden,
      handCards: cards.length,
      // Rounded into 6 px buckets: a fanned row is not pixel-aligned.
      handRows: new Set(slots.map((slot) => Math.round(slot.top / 6))).size,
    };
  });
}

/** Both players draw in turn, which grows both hands one card at a time. */
async function growHand(page: Page, other: Page, target: number): Promise<number> {
  for (let step = 0; step < target * 3; step += 1) {
    const held = await page.locator('.hand .card').count();
    if (held >= target) {
      return held;
    }
    for (const actor of [page, other]) {
      await actor.bringToFront();
      await awaitSettled(actor);
      if (!(await onTurn(actor))) {
        continue;
      }
      const pile = actor.locator('.pile button.card--back');
      if (await pile.isEnabled().catch(() => false)) {
        await pile.click().catch(() => undefined);
      }
    }
  }
  return page.locator('.hand .card').count();
}

test.describe('the table fits the screen', () => {
  test('keeps every card and the whole pile panel on screen, upright and on its side', async ({
    context,
  }) => {
    const host = await context.newPage();
    const guest = await context.newPage();

    await openApp(host, '/');
    const roomCode = await createRoom(host, 'Dana', 2);
    await openApp(guest, '/');
    await joinRoom(guest, 'Eli', roomCode);
    await expect(host.getByText('2 of 2 players')).toBeVisible();
    await host.bringToFront();
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.locator('.hand .card')).toHaveCount(8);

    // A phone upright, with the hand it is dealt.
    await resize(host, { width: 390, height: 664 });
    let report = await measure(host);
    expect(report.cardsOutsideViewport, 'dealt hand, upright').toBe(0);
    expect(report.panelOverflow, 'pile panel, upright').toBeLessThanOrEqual(0);
    expect(report.handRows).toBe(1);

    // The same phone on its side: this is where the hand used to be pushed clean
    // off the bottom of the screen.
    await resize(host, { width: 780, height: 360 });
    report = await measure(host);
    expect(report.cardsOutsideViewport, 'dealt hand, landscape').toBe(0);
    expect(report.panelOverflow, 'pile panel, landscape').toBeLessThanOrEqual(0);

    // A hand well past the point where one row stops fitting.
    await resize(host, { width: 390, height: 664 });
    const held = await growHand(host, guest, 13);
    expect(held, 'the hand did not grow enough to test wrapping').toBeGreaterThanOrEqual(11);

    await host.bringToFront();
    report = await measure(host);
    expect(report.handCards).toBe(held);
    expect(report.cardsOutsideViewport, 'big hand, upright').toBe(0);
    expect(report.panelOverflow, 'pile panel under a big hand').toBeLessThanOrEqual(0);
    expect(report.promptHidden, 'prompt under a big hand').toBe(0);
    // Wrapped rather than scrolled sideways: that is what puts them all on screen.
    expect(report.handRows).toBeGreaterThan(1);

    await resize(host, { width: 780, height: 360 });
    report = await measure(host);
    expect(report.cardsOutsideViewport, 'big hand, landscape').toBe(0);
    expect(report.panelOverflow, 'pile panel, big hand, landscape').toBeLessThanOrEqual(0);
    // All that width is one row's worth.
    expect(report.handRows).toBe(1);
  });

  /*
   * Every hand size, not a sample of them. A player reported a hand of five
   * spreading wider than the screen while a hand of seven fitted — the sort of
   * thing a rule written per size gets you, and the sort of thing only a sweep
   * catches. The arithmetic is unit-tested for 1 to 20 cards; this checks the real
   * layout against whatever sizes a real round happens to produce.
   */
  test('holds every hand size a round throws at it', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();

    await openApp(host, '/');
    const roomCode = await createRoom(host, 'Dana', 2);
    await openApp(guest, '/');
    await joinRoom(guest, 'Eli', roomCode);
    await expect(host.getByText('2 of 2 players')).toBeVisible();
    await host.bringToFront();
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.locator('.hand .card')).toHaveCount(8);
    await resize(host, { width: 390, height: 664 });

    const seen = new Set<number>();
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const report = await measure(host);
      seen.add(report.handCards);
      expect(report.cardsOutsideViewport, `hand of ${report.handCards}`).toBe(0);
      expect(report.panelOverflow, `pile panel under a hand of ${report.handCards}`).toBeLessThanOrEqual(0);
      expect(report.promptHidden, `prompt under a hand of ${report.handCards}`).toBe(0);
      if (!(await playOrDraw(host)) && !(await playOrDraw(guest))) {
        break;
      }
      if (
        await host
          .getByRole('heading', { name: 'Round finished' })
          .isVisible()
          .catch(() => false)
      ) {
        break;
      }
    }

    // A single hand size would pass the loop above without testing anything.
    expect(seen.size, `hand sizes seen: ${[...seen].join(', ')}`).toBeGreaterThan(3);
  });

  /*
   * The prompt is the one row that may never be squeezed out.
   *
   * Reported from a real game: a player holding a fat hand played a Taki, and the
   * Close Taki button was nowhere on the screen — so there was no way to end the
   * turn at all. The hand had asked for its full 52svh, the table was already at
   * its floor, and the prompt was the only row left with any give and no floor of
   * its own, so it was squeezed to nothing. Nothing about that is specific to Taki:
   * every prompt on this table shares the row, and each of them is the only way out
   * of the state it describes.
   *
   * Driven by shortening the screen rather than by drawing thirty cards: the squeeze
   * is a sum of heights, and this way the same arithmetic is reached in seconds
   * instead of sixty round trips to the room. The last tier is a phone in split
   * view, and it is where the prompt used to disappear completely.
   */
  test('never squeezes the prompt off the screen, however little height is left', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();

    await openApp(host, '/');
    const roomCode = await createRoom(host, 'Dana', 2);
    await openApp(guest, '/');
    await joinRoom(guest, 'Eli', roomCode);
    await expect(host.getByText('2 of 2 players')).toBeVisible();
    await host.bringToFront();
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.locator('.hand .card')).toHaveCount(8);

    await resize(host, { width: 390, height: 664 });
    const held = await growHand(host, guest, 14);
    expect(held, 'the hand did not grow enough to fill the screen').toBeGreaterThanOrEqual(12);
    await host.bringToFront();
    await awaitSettled(host);

    for (const height of [664, 560, 480, 430]) {
      await resize(host, { width: 390, height });
      const report = await measure(host);
      expect(report.promptHidden, `prompt at 390x${height} under a hand of ${report.handCards}`).toBe(0);
      // Whatever it had to give up, the hand still shows cards to give up from.
      expect(await host.locator('.hand .card').first().isVisible(), `hand at 390x${height}`).toBe(true);
    }
  });
});

/** One legal move, or `false` if this page has nothing to do. */
async function playOrDraw(page: Page): Promise<boolean> {
  await page.bringToFront();
  await awaitSettled(page);
  for (const name of [/Last card!/, 'Let it through', 'Close Taki', /^Take \d+ cards?$/]) {
    const button = page.getByRole('button', { name });
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
      return true;
    }
  }
  if (!(await onTurn(page))) {
    return false;
  }
  const playable = page.locator('.hand .card--playable').first();
  if (await playable.count()) {
    await playable.click().catch(() => undefined);
    const picker = page.getByRole('dialog');
    if (await picker.isVisible().catch(() => false)) {
      await picker.getByRole('button', { name: 'Green', exact: true }).click();
    }
    return true;
  }
  const pile = page.locator('.pile button.card--back');
  if (await canDrawFrom(page)) {
    await pile.click().catch(() => undefined);
    return true;
  }
  return false;
}
