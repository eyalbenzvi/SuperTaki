import { expect, test, type Page } from '@playwright/test';
import { BROADCAST, awaitSettled, createRoom, joinRoom, onTurn, openApp } from './helpers.ts';

/**
 * The table has to fit the screen it is on.
 *
 * Two reports drove this file, both of them "cut off": the pile panel sliced in
 * half by the bottom of its own region, and — in landscape, and with a big hand
 * upright — cards that were simply not on the screen. Neither is visible to a test
 * that only asks whether an element exists, so these measure geometry: every card
 * inside the viewport, and the panel inside the region that holds it.
 */

interface Report {
  readonly cardsOutsideViewport: number;
  readonly panelOverflow: number;
  readonly handCards: number;
  readonly handRows: number;
}

async function measure(page: Page): Promise<Report> {
  // A hovered card lifts clear of its neighbours, which would read as a second
  // row. The pointer is wherever the last click left it, so park it first.
  await page.mouse.move(0, 0);
  return page.evaluate(() => {
    const rect = (selector: string): DOMRect | null =>
      document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const cards = [...document.querySelectorAll('.hand .card')].map((card) => card.getBoundingClientRect());
    const region = rect('.game__table');
    const panel = rect('.piles');
    return {
      cardsOutsideViewport: cards.filter(
        (card) =>
          card.top < -0.5 ||
          card.bottom > window.innerHeight + 0.5 ||
          card.left < -0.5 ||
          card.right > window.innerWidth + 0.5,
      ).length,
      panelOverflow: region && panel ? Math.round(panel.height - region.height) : 0,
      handCards: cards.length,
      // Rounded into 6 px buckets: a fanned row is not pixel-aligned.
      handRows: new Set(cards.map((card) => Math.round(card.top / 6))).size,
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

    await openApp(host, `/${BROADCAST}`);
    const roomCode = await createRoom(host, 'Dana', 2);
    await openApp(guest, `/${BROADCAST}`);
    await joinRoom(guest, 'Eli', roomCode);
    await expect(host.getByText('2 of 2 players')).toBeVisible();
    await host.bringToFront();
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.locator('.hand .card')).toHaveCount(8);

    // A phone upright, with the hand it is dealt.
    await host.setViewportSize({ width: 390, height: 664 });
    let report = await measure(host);
    expect(report.cardsOutsideViewport, 'dealt hand, upright').toBe(0);
    expect(report.panelOverflow, 'pile panel, upright').toBeLessThanOrEqual(0);
    expect(report.handRows).toBe(1);

    // The same phone on its side: this is where the hand used to be pushed clean
    // off the bottom of the screen.
    await host.setViewportSize({ width: 780, height: 360 });
    report = await measure(host);
    expect(report.cardsOutsideViewport, 'dealt hand, landscape').toBe(0);
    expect(report.panelOverflow, 'pile panel, landscape').toBeLessThanOrEqual(0);

    // A hand well past the point where one row stops fitting.
    await host.setViewportSize({ width: 390, height: 664 });
    const held = await growHand(host, guest, 13);
    expect(held, 'the hand did not grow enough to test wrapping').toBeGreaterThanOrEqual(11);

    await host.bringToFront();
    report = await measure(host);
    expect(report.handCards).toBe(held);
    expect(report.cardsOutsideViewport, 'big hand, upright').toBe(0);
    expect(report.panelOverflow, 'pile panel under a big hand').toBeLessThanOrEqual(0);
    // Wrapped rather than scrolled sideways: that is what puts them all on screen.
    expect(report.handRows).toBeGreaterThan(1);

    await host.setViewportSize({ width: 780, height: 360 });
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

    await openApp(host, `/${BROADCAST}`);
    const roomCode = await createRoom(host, 'Dana', 2);
    await openApp(guest, `/${BROADCAST}`);
    await joinRoom(guest, 'Eli', roomCode);
    await expect(host.getByText('2 of 2 players')).toBeVisible();
    await host.bringToFront();
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.locator('.hand .card')).toHaveCount(8);
    await host.setViewportSize({ width: 390, height: 664 });

    const seen = new Set<number>();
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const report = await measure(host);
      seen.add(report.handCards);
      expect(report.cardsOutsideViewport, `hand of ${report.handCards}`).toBe(0);
      expect(report.panelOverflow, `pile panel under a hand of ${report.handCards}`).toBeLessThanOrEqual(0);
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
  if (await pile.isEnabled().catch(() => false)) {
    await pile.click().catch(() => undefined);
    return true;
  }
  return false;
}
