import { expect, test, type Page } from '@playwright/test';
import {
  createRoom,
  joinRoom,
  openApp,
  expectLogged,
  onTurn,
  playAnyLegalCard,
  switchToEnglish,
  takeAnyTurn,
} from './helpers.ts';

/**
 * Two pages in one browser play a real game against a real room: `wrangler dev`
 * runs the worker, the Durable Object deals the cards and rules on every move,
 * and the pages talk to it over ordinary WebSockets. Nothing here is stubbed —
 * there is no test transport left to stub with.
 *
 * Neither page is special. `creator` is only the one that opened the room, and
 * the sole thing that buys is the lobby buttons.
 */
async function seatTwoPlayers(creator: Page, guest: Page): Promise<string> {
  await openApp(creator, '/');
  const roomCode = await createRoom(creator, 'Dana', 2);

  await openApp(guest, '/');
  await joinRoom(guest, 'Eli', roomCode);

  await expect(creator.getByText('2 of 2 players')).toBeVisible();
  await expect(guest.getByText('2 of 2 players')).toBeVisible();
  return roomCode;
}

test.describe('a two-player game, against the real room', () => {
  test('creates a room, joins by code and starts a game', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);

    await expect(creator.getByRole('button', { name: 'Start game' })).toBeEnabled();
    await expect(guest.getByText('Waiting for the game to start')).toBeVisible();

    await creator.getByRole('button', { name: 'Start game' }).click();

    // Both sides receive the table; each holds exactly eight private cards.
    await expect(creator.locator('.hand .card')).toHaveCount(8);
    await expect(guest.locator('.hand .card')).toHaveCount(8);
    await expect(creator.getByText('Current colour:')).toBeVisible();
    await expect(guest.getByText('Current colour:')).toBeVisible();

    // The room deals the first turn to the first seat, so exactly one side is on turn.
    await expect(creator.locator('.turn-banner--mine')).toBeVisible();
    await expect(guest.locator('.turn-banner')).toHaveText("Dana's turn");
  });

  /*
   * That the drawing decodes to the invite link is settled in the component
   * tests, with a real decoder. What only a browser can answer is whether it is
   * painted at a size a camera can use and whether it stays inside the panel —
   * the QR code shares its row with the room code, and the first version of that
   * layout hung the plate over the edge of the card.
   */
  test('paints the QR code at a scannable size, inside its panel', async ({ page }) => {
    await openApp(page, '/');
    await createRoom(page, 'Dana', 2);

    const qr = page.locator('.qr');
    await expect(qr).toBeVisible();
    await expect(qr).toHaveAttribute('aria-label', /QR code with the invite link/);

    const symbol = (await qr.boundingBox()) ?? { width: 0, height: 0, x: 0, y: 0 };
    const panel = (await page.locator('.invite').boundingBox()) ?? { width: 0, x: 0 };
    expect(symbol.width).toBeGreaterThanOrEqual(100);
    expect(Math.abs(symbol.width - symbol.height)).toBeLessThanOrEqual(1);
    expect(symbol.x).toBeGreaterThanOrEqual(panel.x - 1);
    expect(symbol.x + symbol.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
  });

  test('joins through an invite link', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();

    await openApp(creator, '/');
    const roomCode = await createRoom(creator, 'Dana', 4);

    await guest.goto(`/#/join?room=${roomCode}`);
    await switchToEnglish(guest);
    await expect(guest.getByText(`Invitation detected for room ${roomCode}`)).toBeVisible();
    await guest.getByLabel('Your display name').fill('Eli');
    await guest.getByRole('button', { name: 'Join room' }).click();

    await expect(creator.getByText('2 of 4 players')).toBeVisible();
    // The invite parameters are removed from the address bar afterwards.
    expect(new URL(guest.url()).hash).toBe('');
  });

  test('keeps hands private between players', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);
    await creator.getByRole('button', { name: 'Start game' }).click();
    await expect(guest.locator('.hand .card')).toHaveCount(8);

    const creatorLabels = await creator
      .locator('.hand .card')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    const guestLabels = await guest
      .locator('.hand .card')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));

    // The opponent's cards are only ever shown face down.
    await expect(guest.locator('.seat .card--back')).toHaveCount(1);
    expect(creatorLabels).toHaveLength(8);
    expect(guestLabels).toHaveLength(8);
    // Guest markup must not contain the other hand's card faces.
    const guestHtml = await guest.content();
    const unique = creatorLabels.filter((label) => label && !guestLabels.includes(label));
    for (const label of unique.slice(0, 4)) {
      expect(guestHtml).not.toContain(`Play ${label?.replace('Play ', '') ?? ''} `);
    }
  });

  test('plays a card and passes the turn', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);
    await creator.getByRole('button', { name: 'Start game' }).click();
    await expect(creator.locator('.turn-banner--mine')).toBeVisible();

    /*
     * An opening hand with nothing legal in it is uncommon — roughly one deal
     * in fifty — but it does happen, and this test is about what a *play*
     * does. Draw, let the guest move, and come back round until Dana is
     * holding something she can put down.
     */
    let before = 0;
    let ready = false;
    for (let step = 0; step < 24 && !ready; step += 1) {
      await creator.bringToFront();
      const mine = await onTurn(creator);
      if (!mine) {
        await takeAnyTurn(guest);
        continue;
      }
      before = await creator.locator('.hand .card').count();
      const playable = creator.locator('.hand .card--playable');
      /*
       * One card in the deck is not an ordinary play, and this loop selects for it.
       *
       * A +3 Breaker played with no +3 to break is legal and costs its owner three
       * cards, so the hand *grows* by two — while the assertion below is about a card
       * leaving a hand. Drawing until something is playable makes an all-wild hand far
       * likelier than it is in a real game, and the breaker sorts last, so
       * `playAnyLegalCard` reaches for it exactly when it is the only playable card.
       * That was a real failure at about one run in fifty, and it read as the hand
       * mysteriously gaining cards. So: keep drawing until there is a card whose play
       * is a plain play.
       */
      const labels = await playable.evaluateAll((cards) =>
        cards.map((card) => card.getAttribute('aria-label') ?? ''),
      );
      if (labels.some((label) => !label.includes('Break +3'))) {
        ready = true;
        break;
      }
      await creator.getByRole('button', { name: /Draw pile, \d+ cards/ }).click();
    }
    expect(ready, 'Dana never came round to a playable card').toBe(true);

    await playAnyLegalCard(creator);

    // The hand shrinks (or the turn returns after a Stop/Plus); in every case
    // the log records the play on both sides.
    await expect(creator.locator('.hand .card')).toHaveCount(before - 1);
    await expectLogged(creator, 'Dana played');
    await expectLogged(guest, 'Dana played');
  });

  test('lets a player draw when nothing is playable', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);
    await creator.getByRole('button', { name: 'Start game' }).click();
    await expect(creator.locator('.turn-banner--mine')).toBeVisible();

    const drawPile = creator.getByRole('button', { name: /Draw pile, \d+ cards/ });
    await expect(drawPile).toHaveAttribute('aria-disabled', 'false');
    await drawPile.click();
    await expect(guest.locator('.turn-banner--mine')).toBeVisible();
    await expectLogged(creator, 'Dana drew a card');
  });

  test('refuses the draw pile and the hand when it is not your turn', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);
    await creator.getByRole('button', { name: 'Start game' }).click();
    await expect(guest.locator('.turn-banner')).toHaveText("Dana's turn");

    await expect(guest.getByRole('button', { name: /Draw pile, \d+ cards/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(guest.locator('.hand .card--playable')).toHaveCount(0);
    /*
     * The cards stay focusable — see `PlayableCard` — so that a keyboard or
     * screen-reader player can still read their own hand while they wait. Being
     * unplayable is carried by `aria-disabled`, and a press explains itself.
     *
     * The pile now works the same way, for the same reasons: a real `disabled`
     * attribute gave it no press feedback and hid the reason it was blocked in a
     * `title` most browsers never show. The cost is a tab stop while it is
     * blocked, which is most of a game.
     */
    const firstCard = guest.locator('.hand .card').first();
    await expect(firstCard).toHaveAttribute('aria-disabled', 'true');
    // Chromium stops driving animation frames in a background tab, which hangs
    // Playwright's stability check; the guest has to be the visible page. The
    // click is forced because Playwright treats `aria-disabled` as un-clickable,
    // while a real finger lands on the card regardless — which is the whole point
    // of keeping it reachable and having it answer back.
    await guest.bringToFront();
    await firstCard.click({ force: true });
    await expect(guest.getByRole('alert')).toContainText('Wait for your turn');
  });

  test('lets the seat with the lobby buttons remove a player before the game starts', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);

    await creator.getByRole('button', { name: 'Remove Eli' }).click();
    // Throwing somebody out cannot be undone from their side, and the control sits
    // beside their name in a list, so it asks first.
    await creator.getByRole('dialog').getByRole('button', { name: 'Remove player' }).click();
    await expect(creator.getByText('1 of 2 players')).toBeVisible();
    await expect(guest.getByText('You were removed from the room')).toBeVisible();
  });

  test('leaves the room open for everybody else when the creator goes', async ({ context }) => {
    /*
     * This test used to assert the opposite, and the assertion was true: the room
     * *was* the creator's tab, so their leaving closed it on everybody, and the UI
     * said so in as many words. The room outlives every player now, so what has to
     * be proved is that nothing happens to the people still at it.
     */
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);

    await creator.getByRole('button', { name: 'Leave' }).click();
    await creator.getByRole('dialog').getByRole('button', { name: 'Leave' }).click();

    // Still in the room, still seated, and now holding the lobby buttons.
    await expect(guest.getByRole('button', { name: 'Start game' })).toBeVisible();
    await expect(guest.getByText('1 of 2 players')).toBeVisible();
    await expect(guest.getByText(/room is closed/)).toBeHidden();
  });

  test('refuses a third player in a two-player room', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    const third = await context.newPage();
    const roomCode = await seatTwoPlayers(creator, guest);

    await openApp(third, '/');
    await joinRoom(third, 'Noa', roomCode);
    await expect(third.getByText('The room is full')).toBeVisible();
  });

  test('says plainly that a room code leads nowhere', async ({ page }) => {
    // A mistyped code used to surface as "no such peer" from the broker. It is now the
    // room itself answering, because there is nothing in it.
    await openApp(page, '/');
    await joinRoom(page, 'Dana', '482914');
    await expect(page.getByText('The room is closed')).toBeVisible();
    await expect(page.getByText('Why can this happen?')).toBeVisible();
  });
});
