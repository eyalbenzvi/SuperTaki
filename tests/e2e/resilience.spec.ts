import { expect, test, type Page } from '@playwright/test';
import { createRoom, joinRoom, openApp, openSettings, switchToEnglish } from './helpers.ts';

/**
 * The scenarios that used to end a game, played through the real UI against the real
 * room.
 *
 * These used to be about the *host's* tab and everything built to survive its
 * disappearance: a resume card, a room-code reclaim, a handover to another player.
 * None of that exists any more, and what is left is much smaller to say and much
 * stronger to have: any player can reload, and their seat is where they left it.
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

test.describe('a player that reloads mid-round', () => {
  test('comes straight back to the same seat, with the same hand', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);

    await creator.getByRole('button', { name: 'Start game' }).click();
    await expect(creator.locator('.hand .card')).toHaveCount(8);
    await expect(guest.locator('.hand .card')).toHaveCount(8);

    await guest.reload();
    await switchToEnglish(guest);

    /*
     * One tap. The credential is in `localStorage` and the round is in the room, so
     * the client presents it and is handed back the same eight cards. It is a tap
     * rather than nothing on purpose: a shared device should not rejoin somebody's
     * game because a page happened to load.
     */
    await guest.getByRole('button', { name: 'Rejoin' }).click();
    await expect(guest.locator('.hand .card')).toHaveCount(8);
    await expect(creator.locator('.hand .card')).toHaveCount(8);
  });

  test('holds the table for the player who opened the room, exactly like anybody else', async ({
    context,
  }) => {
    /*
     * The whole point of moving the game to the server, in one test.
     *
     * Before this, reloading here destroyed the only complete copy of the state. The
     * apparatus that grew around that — a snapshot of the entire game in
     * `localStorage`, a "Carry on hosting" card, a room-code reclaim with an
     * eight-attempt retry ladder — existed so that a player could press a button and
     * hope. There is no button now, because there is nothing to reclaim.
     */
    const creator = await context.newPage();
    const guest = await context.newPage();
    const roomCode = await seatTwoPlayers(creator, guest);

    await creator.getByRole('button', { name: 'Start game' }).click();
    await expect(creator.locator('.hand .card')).toHaveCount(8);
    await expect(guest.locator('.hand .card')).toHaveCount(8);

    await creator.reload();
    await switchToEnglish(creator);

    // The same one tap everybody else gets. No "carry on hosting", no reclaim.
    await creator.getByRole('button', { name: 'Rejoin' }).click();
    await expect(creator.locator('.hand .card')).toHaveCount(8);
    // The same room, on the same code, for everybody.
    await expect(guest.locator('.hand .card')).toHaveCount(8);
    await openSettings(creator);
    await expect(creator.getByText(new RegExp(roomCode)).first()).toBeVisible();
  });

  test('leaves the others playing while one seat is away', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);

    await creator.getByRole('button', { name: 'Start game' }).click();
    await expect(guest.locator('.hand .card')).toHaveCount(8);

    await guest.close();

    // The table is still a table: the player who is still here is not sent home, and
    // is not told the room has closed.
    await expect(creator.locator('.hand .card')).toHaveCount(8);
    await expect(creator.getByRole('button', { name: 'Create game' })).toBeHidden();
  });
});

test.describe('a table that needs a moment', () => {
  test('can be paused and carried on', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);
    await creator.getByRole('button', { name: 'Start game' }).click();
    await expect(creator.locator('.hand .card')).toHaveCount(8);

    await openSettings(creator);
    await creator.getByRole('button', { name: 'Ask the table to wait' }).click();
    await creator.getByRole('button', { name: 'Done' }).click();
    // Everybody sees it, which is the point: a pause nobody else knows about is just
    // a player who has stopped responding.
    await expect(creator.getByText('The table is paused')).toBeVisible();
    await expect(guest.getByText('The table is paused')).toBeVisible();

    await openSettings(creator);
    await creator.getByRole('button', { name: 'Carry on', exact: true }).click();
    await creator.getByRole('button', { name: 'Done' }).click();
    await expect(creator.getByText('The table is paused')).toBeHidden();
    await expect(guest.getByText('The table is paused')).toBeHidden();
  });

  test('can end a round by agreement, with no winner', async ({ context }) => {
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);
    await creator.getByRole('button', { name: 'Start game' }).click();
    await expect(creator.locator('.hand .card')).toHaveCount(8);

    await openSettings(creator);
    await creator.getByRole('button', { name: 'End this round' }).click();
    await creator.getByRole('button', { name: 'End it' }).click();
    await openSettings(guest);
    await guest.getByRole('button', { name: 'End this round' }).click();
    await guest.getByRole('button', { name: 'End it' }).click();

    // What a real table does when somebody has to leave: you stop, and nobody
    // pretends the interrupted hand produced a champion.
    await expect(creator.getByRole('table')).toBeVisible();
    await expect(creator.locator('.standings__winner')).toHaveCount(0);
  });
});

test.describe('leaving', () => {
  test('is just leaving, and the room stays open for everybody else', async ({ context }) => {
    /*
     * This used to offer a negotiation: hand the room to somebody, wait for them to
     * accept, and only then step down — because leaving otherwise closed the room on
     * everyone. The room is not in anybody's tab, so there is one button and one
     * outcome.
     */
    const creator = await context.newPage();
    const guest = await context.newPage();
    await seatTwoPlayers(creator, guest);

    await creator.getByRole('button', { name: 'Leave' }).first().click();
    const dialog = creator.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('stays open for everyone else');
    // And the one thing that does change hands is said out loud.
    await expect(dialog).toContainText('pass to the next player');

    await dialog.getByRole('button', { name: 'Leave' }).click();
    await expect(creator.getByRole('button', { name: 'Create game' })).toBeVisible();
    // The other player is still in the room, and now holds the lobby buttons.
    await expect(guest.getByRole('button', { name: 'Start game' })).toBeVisible();
  });
});

test.describe('support information', () => {
  test('records connection events locally and offers them for copying', async ({ context }) => {
    const page = await context.newPage();
    await openApp(page, '/');
    await createRoom(page, 'Dana', 2);

    await page.locator('.topbar__controls button').last().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Support information')).toBeVisible();
    // Local only. The value is being able to tell a network failure from a suspended
    // tab, which otherwise look identical.
    await expect(dialog.getByText('It is never sent anywhere.')).toBeVisible();
  });
});
