import { expect, test, type Page } from '@playwright/test';
import { BROADCAST, createRoom, joinRoom, openApp } from './helpers.ts';

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
}

test.describe('reduced motion', () => {
  test('still says that something changed, without moving anything', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await host.emulateMedia({ reducedMotion: 'reduce' });
    await seatAndDeal(host, guest);

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

    const animation = await host
      .locator('.discard .card--landing')
      .evaluate((node) => getComputedStyle(node).animationName);
    // Without the preference the original cue is what runs, unchanged.
    expect(animation).toBe('land');
  });
});
