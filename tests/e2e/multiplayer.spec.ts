import { expect, test, type Page } from '@playwright/test';
import {
  BROADCAST,
  createRoom,
  joinRoom,
  openApp,
  playAnyLegalCard,
  switchToEnglish,
  takeAnyTurn,
} from './helpers.ts';

/**
 * Two pages in one browser play a real game over the BroadcastChannel
 * transport. Everything above the transport — protocol, host authority, engine,
 * UI — is the production code path.
 */
async function seatTwoPlayers(host: Page, guest: Page): Promise<string> {
  await openApp(host, `/${BROADCAST}`);
  const roomCode = await createRoom(host, 'Dana', 2);

  await openApp(guest, `/${BROADCAST}`);
  await joinRoom(guest, 'Eli', roomCode);

  await expect(host.getByText('2 of 2 players')).toBeVisible();
  await expect(guest.getByText('2 of 2 players')).toBeVisible();
  return roomCode;
}

test.describe('two-player game over the deterministic transport', () => {
  test('creates a room, joins by code and starts a game', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);

    await expect(host.getByRole('button', { name: 'Start game' })).toBeEnabled();
    await expect(guest.getByText('Waiting for the host to start')).toBeVisible();

    await host.getByRole('button', { name: 'Start game' }).click();

    // Both sides receive the table; each holds exactly eight private cards.
    await expect(host.locator('.hand .card')).toHaveCount(8);
    await expect(guest.locator('.hand .card')).toHaveCount(8);
    await expect(host.getByText('Current colour:')).toBeVisible();
    await expect(guest.getByText('Current colour:')).toBeVisible();

    // The host plays first, so exactly one side is on turn.
    await expect(host.getByText('Your turn')).toBeVisible();
    await expect(guest.getByText("Dana's turn")).toBeVisible();
  });

  test('joins through an invite link', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();

    await openApp(host, `/${BROADCAST}`);
    const roomCode = await createRoom(host, 'Dana', 4);

    await guest.goto(`/${BROADCAST}#/join?room=${roomCode}`);
    await switchToEnglish(guest);
    await expect(guest.getByText(`Invitation detected for room ${roomCode}`)).toBeVisible();
    await guest.getByLabel('Your display name').fill('Eli');
    await guest.getByRole('button', { name: 'Join room' }).click();

    await expect(host.getByText('2 of 4 players')).toBeVisible();
    // The invite parameters are removed from the address bar afterwards.
    expect(new URL(guest.url()).hash).toBe('');
  });

  test('keeps hands private between players', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(guest.locator('.hand .card')).toHaveCount(8);

    const hostLabels = await host
      .locator('.hand .card')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    const guestLabels = await guest
      .locator('.hand .card')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));

    // The opponent's cards are only ever shown face down.
    await expect(guest.locator('.opponent .card--back')).toHaveCount(1);
    expect(hostLabels).toHaveLength(8);
    expect(guestLabels).toHaveLength(8);
    // Guest markup must not contain the host's card faces.
    const guestHtml = await guest.content();
    const uniqueHostLabels = hostLabels.filter((label) => label && !guestLabels.includes(label));
    for (const label of uniqueHostLabels.slice(0, 4)) {
      expect(guestHtml).not.toContain(`Play ${label?.replace('Play ', '') ?? ''} `);
    }
  });

  test('plays a card and passes the turn', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.getByText('Your turn')).toBeVisible();

    /*
     * An opening hand with nothing legal in it is uncommon — roughly one deal
     * in fifty — but it does happen, and this test is about what a *play*
     * does. Draw, let the guest move, and come back round until the host is
     * holding something it can put down.
     */
    let before = 0;
    let ready = false;
    for (let step = 0; step < 24 && !ready; step += 1) {
      await host.bringToFront();
      const hostOnTurn = await host
        .getByText('Your turn')
        .isVisible()
        .catch(() => false);
      if (!hostOnTurn) {
        await takeAnyTurn(guest);
        continue;
      }
      before = await host.locator('.hand .card').count();
      if ((await host.locator('.hand .card--playable').count()) > 0) {
        ready = true;
        break;
      }
      await host.getByRole('button', { name: /Draw pile, \d+ cards/ }).click();
    }
    expect(ready, 'the host never came round to a playable card').toBe(true);

    await playAnyLegalCard(host);

    // The host's hand shrinks (or the turn returns after a Stop/Plus);
    // in every case the log records the play on both sides.
    await expect(host.locator('.feed__item', { hasText: 'Dana played' }).first()).toBeVisible();
    await expect(guest.locator('.feed__item', { hasText: 'Dana played' }).first()).toBeVisible();
    await expect(host.locator('.hand .card')).toHaveCount(before - 1);
  });

  test('lets a player draw when nothing is playable', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.getByText('Your turn')).toBeVisible();

    const drawPile = host.getByRole('button', { name: /Draw pile, \d+ cards/ });
    await expect(drawPile).toBeEnabled();
    await drawPile.click();
    await expect(host.locator('.feed__item', { hasText: 'Dana drew a card' })).toBeVisible();
    await expect(guest.getByText('Your turn')).toBeVisible();
  });

  test('disables the draw pile and hand when it is not your turn', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(guest.getByText("Dana's turn")).toBeVisible();

    await expect(guest.getByRole('button', { name: /Draw pile, \d+ cards/ })).toBeDisabled();
    await expect(guest.locator('.hand .card--playable')).toHaveCount(0);
    const firstCard = guest.locator('.hand .card').first();
    await expect(firstCard).toBeDisabled();
  });

  test('lets the host remove a player before the game starts', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);

    await host.getByRole('button', { name: 'Remove Eli' }).click();
    await expect(host.getByText('1 of 2 players')).toBeVisible();
    await expect(guest.getByText('The host removed you from the room')).toBeVisible();
  });

  test('tells the guest the room is gone when the host leaves', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);

    await host.getByRole('button', { name: 'Leave' }).click();
    await host.getByRole('dialog').getByRole('button', { name: 'Leave' }).click();

    await expect(guest.getByText('the room is closed')).toBeVisible();
    await expect(guest.getByText('cannot continue without the host')).toBeVisible();
  });

  test('refuses a third player in a two-player room', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    const third = await context.newPage();
    const roomCode = await seatTwoPlayers(host, guest);

    await openApp(third, `/${BROADCAST}`);
    await joinRoom(third, 'Noa', roomCode);
    await expect(third.getByText('The room is full')).toBeVisible();
  });

  test('reports an unreachable room honestly', async ({ page }) => {
    await openApp(page, `/${BROADCAST}`);
    await joinRoom(page, 'Dana', 'TIGER-MANGO-99');
    await expect(page.getByText('The host could not be reached')).toBeVisible();
    await expect(page.getByText('Why can this happen?')).toBeVisible();
  });
});
