import { expect, test, type Page } from '@playwright/test';
import { BROADCAST, createRoom, joinRoom, openApp, openSettings, switchToEnglish } from './helpers.ts';

/**
 * The scenarios that used to end a game, played through the real UI.
 *
 * The transport is the same-browser one, so these prove the *product* behaviour —
 * that the host's page can reload without the round being lost, and that a table
 * can pause and stop by agreement — rather than anything about ICE. The failures
 * that need a real data channel are covered by the fault-injecting unit tests;
 * pretending otherwise here would produce a suite that looks reassuring and
 * measures nothing.
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

test.describe('a host that reloads', () => {
  test('is offered its room back, on the same room code', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    const roomCode = await seatTwoPlayers(host, guest);

    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.locator('.hand .card')).toHaveCount(8);
    await expect(guest.locator('.hand .card')).toHaveCount(8);

    // The accident this whole effort exists for. Before it, the game was simply
    // gone: the only complete copy of the state lived in this tab's memory.
    await host.reload();
    await switchToEnglish(host);

    const resume = host.getByRole('button', { name: 'Carry on hosting' });
    await expect(resume).toBeVisible();
    // The *same* room code, which is the whole point: every invite already sent
    // still works and every guest's stored credential still fits, so the table
    // reassembles itself without anybody being told anything.
    await expect(host.getByText(new RegExp(roomCode)).first()).toBeVisible();
  });

  test('leaves a guest holding their seat rather than sending them home', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);

    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(guest.locator('.hand .card')).toHaveCount(8);

    await host.reload();

    // The guest is told the seat is being held, and is *not* dropped back to the
    // landing page with the round discarded — which is what used to happen the
    // moment the host's page went away.
    await expect(guest.getByText(/Reconnecting|seat is being held|Waiting for/).first()).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Create game' })).toBeHidden();
  });
});

test.describe('a table that needs a moment', () => {
  test('can be paused and carried on', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.locator('.hand .card')).toHaveCount(8);

    await openSettings(host);
    await host.getByRole('button', { name: 'Ask the table to wait' }).click();
    await host.getByRole('button', { name: 'Done' }).click();
    // Everybody sees it, which is the point: a pause nobody else knows about is
    // just a player who has stopped responding.
    await expect(host.getByText('The table is paused')).toBeVisible();
    await expect(guest.getByText('The table is paused')).toBeVisible();

    await openSettings(host);
    await host.getByRole('button', { name: 'Carry on', exact: true }).click();
    await host.getByRole('button', { name: 'Done' }).click();
    await expect(host.getByText('The table is paused')).toBeHidden();
    await expect(guest.getByText('The table is paused')).toBeHidden();
  });

  test('can end a round by agreement, with no winner', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host.locator('.hand .card')).toHaveCount(8);

    await openSettings(host);
    await host.getByRole('button', { name: 'End this round' }).click();
    await host.getByRole('button', { name: 'End it' }).click();
    await openSettings(guest);
    await guest.getByRole('button', { name: 'End this round' }).click();
    await guest.getByRole('button', { name: 'End it' }).click();

    // This is what a real table does when somebody has to leave, and having it is
    // most of the reason an automatic host takeover is not needed.
    await expect(host.getByRole('table')).toBeVisible();
    await expect(host.locator('.standings__winner')).toHaveCount(0);
  });
});

test.describe('handing the room over', () => {
  test('offers a host with company a handover instead of only closing the room', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(host, guest);

    await host.getByRole('button', { name: 'Leave' }).first().click();
    const dialog = host.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Both options are present, and ending somebody else's evening is no longer
    // the only one.
    await expect(dialog.getByRole('button', { name: 'Hand over and leave' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close the room for everyone' })).toBeVisible();
  });
});

test.describe('support information', () => {
  test('records connection events locally and offers them for copying', async ({ context }) => {
    const page = await context.newPage();
    await openApp(page, `/${BROADCAST}`);
    await createRoom(page, 'Dana', 2);

    await page.locator('.topbar__controls button').last().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Support information')).toBeVisible();
    // Local only. The value is being able to tell a network failure from a
    // suspended tab from a host reload, which otherwise look identical.
    await expect(dialog.getByText('It is never sent anywhere.')).toBeVisible();
  });
});
