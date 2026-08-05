import { expect, test, type Page } from '@playwright/test';
import { BROADCAST, awaitSettled, canDrawFrom, createRoom, joinRoom, onTurn, openApp } from './helpers.ts';

/**
 * What only a browser can answer about motion.
 *
 * The unit suite runs in jsdom, which implements no Web Animations API and
 * computes no styles worth reading, so the questions here — does the reduced
 * motion rule leave any cue at all, and does it leave one without reviving a
 * transform — are unanswerable anywhere else.
 */

async function seatAndDeal(host: Page, guest: Page): Promise<void> {
  await openApp(host, `/${BROADCAST}`);
  const roomCode = await createRoom(host, 'Dana', 2);
  await openApp(guest, `/${BROADCAST}`);
  await joinRoom(guest, 'Eli', roomCode);
  await expect(host.getByText('2 of 2 players')).toBeVisible();
  await host.getByRole('button', { name: 'Start game' }).click();
  await expect(host.locator('.hand .card')).toHaveCount(8);
  // Both hands, because the comparisons below read one state off each page.
  await expect(guest.locator('.hand .card')).toHaveCount(8);
}

/**
 * Plays one card, so that a beat containing `cardPlayed` exists.
 *
 * Needed because the landing cue is no longer applied on mount: it used to ride
 * on a `key`, which replayed it on any remount, so a reconnecting client watched
 * a card land that nobody had played. Asserting it now means causing it.
 */
async function playOneCard(host: Page): Promise<void> {
  const playable = host.locator('.hand .card--playable').first();
  await expect(playable).toBeVisible();
  await playable.click();
  const picker = host.getByRole('dialog');
  if (await picker.isVisible().catch(() => false)) {
    await picker.getByRole('button', { name: 'Green', exact: true }).click();
  }
  await expect(host.locator('.discard .card--landing')).toBeVisible();
}

test.describe('reduced motion', () => {
  test('still says that something changed, without moving anything', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await host.emulateMedia({ reducedMotion: 'reduce' });
    await seatAndDeal(host, guest);
    await playOneCard(host);

    const landing = host.locator('.discard .card--landing');
    await expect(landing).toBeVisible();

    /*
     * The cue survives. Before this it did not: the blanket rule zeroed every
     * duration, so a player who asked for less motion got a discard pile that
     * changed between frames and a ticker whose text swapped in silence.
     */
    const animation = await landing.evaluate((node) => {
      const style = getComputedStyle(node);
      return { name: style.animationName, duration: style.animationDuration };
    });
    expect(animation.name).toBe('land-reduced');
    expect(animation.duration).not.toBe('0.001ms');

    // And it is opacity only. `land` translates, rotates and scales as well as
    // fading, which is exactly why it is not the animation that runs here.
    const keyframeProperties = await host.evaluate(() => {
      const found: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSKeyframesRule && rule.name === 'land-reduced') {
            for (const frame of Array.from(rule.cssRules)) {
              if (frame instanceof CSSKeyframeRule) {
                found.push(...Array.from(frame.style));
              }
            }
          }
        }
      }
      return found;
    });
    expect(keyframeProperties.length).toBeGreaterThan(0);
    expect(keyframeProperties).not.toContain('transform');

    // The colour in force is a rule of the game, so its change stays legible.
    const discardDuration = await host
      .locator('.discard')
      .evaluate((node) => getComputedStyle(node).transitionDuration);
    expect(discardDuration).not.toBe('0.001ms');
  });

  test('leaves the looping cues stopped', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await host.emulateMedia({ reducedMotion: 'reduce' });
    await seatAndDeal(host, guest);

    /*
     * A dot that pulses for ever is precisely what somebody asking for less
     * motion is asking to be rid of, and its meaning is carried in words beside
     * it either way. Restoring cues by name rather than by property is what
     * keeps this true: an allowlist keyed on "opacity only" would have let it
     * straight back in.
     */
    const iterations = await host.evaluate(() => {
      const probe = document.createElement('span');
      probe.className = 'health health--unstable';
      const dot = document.createElement('span');
      dot.className = 'health__dot';
      probe.append(dot);
      document.body.append(probe);
      const value = getComputedStyle(dot).animationIterationCount;
      probe.remove();
      return value;
    });
    expect(iterations).toBe('1');
  });

  test('normal motion is untouched', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatAndDeal(host, guest);
    await playOneCard(host);

    const animation = await host
      .locator('.discard .card--landing')
      .evaluate((node) => getComputedStyle(node).animationName);
    // Without the preference the original cue is what runs, unchanged.
    expect(animation).toBe('land');
  });
});

test.describe('cues that had to stop costing layout', () => {
  test('the turn banner changes without reflowing the row', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatAndDeal(host, guest);

    const rowHeight = async (page: Page): Promise<number> =>
      page.locator('.turn-row').evaluate((node) => node.getBoundingClientRect().height);

    /*
     * The emphasised banner used to step from --text-md to --text-lg. Font size is
     * a layout property, so the most frequent state change in the game reflowed
     * the row it sits in, untransitioned. Both players are on the same table and
     * exactly one of them is on turn, so comparing the two pages compares the two
     * states at the same viewport.
     */
    const mine = await host.locator('.turn-banner--mine').count();
    const theirs = await guest.locator('.turn-banner--mine').count();
    expect(mine + theirs).toBe(1);
    expect(await rowHeight(host)).toBeCloseTo(await rowHeight(guest), 0);
  });

  test('the playable ring is drawn without repainting the card', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatAndDeal(host, guest);

    const ring = await host
      .locator('.hand .card--playable')
      .first()
      .evaluate((node) => {
        const after = getComputedStyle(node, '::after');
        return { opacity: after.opacity, shadow: after.boxShadow };
      });
    // The ring lives on the pseudo-element and fades its opacity; a turn change
    // no longer transitions a four-layer box-shadow on up to eight cards at once.
    expect(ring.opacity).toBe('1');
    expect(ring.shadow).toContain('inset');

    const dimmed = host.locator('.hand .card--dimmed').first();
    if ((await dimmed.count()) > 0) {
      const hidden = await dimmed.evaluate((node) => getComputedStyle(node, '::after').opacity);
      expect(hidden).toBe('0');
    }
  });

  test('the draw pile shows how much of it is left', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatAndDeal(host, guest);

    const deck = host.locator('.pile__deck');
    await expect(deck).toHaveAttribute('data-depth', /[0-3]/);
    // The stack must contribute no layout: the pile card's size is solved from
    // the height left after a hand-measured chrome constant.
    const contributes = await deck.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.marginTop].join(' ');
    });
    expect(contributes).toBe('0px 0px 0px 0px');
  });
});

test.describe('the table at 320px', () => {
  test('fits, with every new cue present', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await host.setViewportSize({ width: 320, height: 568 });
    await seatAndDeal(host, guest);

    // The narrowest phone anybody still uses, which nothing measured before now.
    const report = await host.evaluate(() => {
      const cards = [...document.querySelectorAll('.hand .card')].map((card) => card.getBoundingClientRect());
      const region = document.querySelector('.game__table')?.getBoundingClientRect();
      const panel = document.querySelector('.piles')?.getBoundingClientRect();
      return {
        offscreen: cards.filter(
          (card) =>
            card.top < -0.5 ||
            card.bottom > window.innerHeight + 0.5 ||
            card.left < -0.5 ||
            card.right > window.innerWidth + 0.5,
        ).length,
        panelOverflow: region && panel ? Math.round(panel.height - region.height) : 0,
        scrolls: document.scrollingElement
          ? document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight
          : 0,
      };
    });

    expect(report.offscreen, 'a lifted card must not clip at 320px').toBe(0);
    expect(report.panelOverflow, 'the depth stack must not push the pile out').toBeLessThanOrEqual(0);
    expect(report.scrolls, 'the table never scrolls').toBeLessThanOrEqual(1);
  });
});

test.describe('residue', () => {
  test('leaves nothing behind after a long round', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatAndDeal(host, guest);

    /*
     * The failure mode an imperative overlay invites: clones appended and never
     * removed, or a promoted layer never released, both of which accumulate
     * silently and only show up as a phone getting warm.
     */
    const residue = async (page: Page): Promise<Record<string, number>> =>
      page.evaluate(() => ({
        cards: document.querySelectorAll('.flight-layer__card').length,
        pulses: document.querySelectorAll('.flight-layer__pulse').length,
        promoted: [...document.querySelectorAll<HTMLElement>('.hand__slot')].filter(
          (slot) => slot.style.willChange !== '',
        ).length,
        focusableClones: [...document.querySelectorAll('.flight-layer button, .flight-layer [tabindex]')]
          .length,
      }));

    for (let move = 0; move < 12; move += 1) {
      if (!(await playOrDrawOnce(host)) && !(await playOrDrawOnce(guest))) {
        break;
      }
      if ((await host.getByRole('heading', { name: 'Round finished' }).count()) > 0) {
        break;
      }
    }

    // Long enough for every flight and pulse in flight to have finished.
    await host.waitForTimeout(1500);

    const left = await residue(host);
    expect(left.cards, 'clones left on the layer').toBe(0);
    expect(left.pulses, 'pulses left on the layer').toBe(0);
    expect(left.promoted, 'slots still asking for a composited layer').toBe(0);
    // A focusable clone inside an aria-hidden layer is a tab stop that announces
    // nothing — worse than either hiding it or leaving it alone.
    expect(left.focusableClones, 'focusable clones').toBe(0);
  });
});

/** One move by whichever page can make one. */
async function playOrDrawOnce(page: Page): Promise<boolean> {
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
  if (await canDrawFrom(page)) {
    await page
      .locator('.pile button.card--back')
      .click()
      .catch(() => undefined);
    return true;
  }
  return false;
}
