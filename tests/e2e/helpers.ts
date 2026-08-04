import { expect, type Page } from '@playwright/test';

/** Query string that selects the deterministic same-browser transport. */
export const BROADCAST = '?transport=broadcast';

/** Loads the app and switches the UI to English so assertions read clearly. */
export async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await switchToEnglish(page);
}

/**
 * Language lives in the settings sheet now, not permanently in the top bar: on a
 * phone the two segmented controls cost about a fifth of the screen.
 *
 * The gear's own accessible name is localised, so it is found by position rather
 * than by label — the caller does not always know which language is loaded.
 */
export async function openSettings(page: Page): Promise<void> {
  await page.locator('.topbar__controls button').last().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

export async function switchToEnglish(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByRole('radio', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

export async function createRoom(page: Page, name: string, maxPlayers = 4): Promise<string> {
  await page.getByRole('button', { name: 'Create game' }).click();
  await page.getByLabel('Your display name').fill(name);
  await page.getByRole('radio', { name: String(maxPlayers), exact: true }).click();
  await page.getByRole('button', { name: 'Create room' }).click();

  const code = page.locator('.code-value').first();
  await expect(code).toBeVisible();
  const roomCode = (await code.textContent())?.trim() ?? '';
  expect(roomCode).toMatch(/^\d{6}$/);
  return roomCode;
}

export async function joinRoom(page: Page, name: string, roomCode: string): Promise<void> {
  await page.getByRole('button', { name: 'Join game' }).click();
  await page.getByLabel('Your display name').fill(name);
  await page.getByLabel('Invite link or room code').fill(roomCode);
  await page.getByRole('button', { name: 'Join room' }).click();
}

/**
 * Waits for a submitted move to be answered.
 *
 * A move locks the hand and the pile until the table replies, so acting before
 * that would stall on Playwright's actionability check instead of on the game.
 * A player waits for the table to settle too.
 */
export async function awaitSettled(page: Page): Promise<void> {
  await page
    .locator('.game__action', { hasText: /Sending your move|שולח את המהלך/ })
    .waitFor({ state: 'hidden', timeout: 5000 })
    .catch(() => undefined);
}

/**
 * Whether this page is the one on turn.
 *
 * Matched on the banner's own class rather than on the words "Your turn": the
 * shell's live region carries the same phrase, and a text search would find two
 * elements and throw.
 */
export async function onTurn(page: Page): Promise<boolean> {
  return page
    .locator('.turn-banner--mine')
    .isVisible()
    .catch(() => false);
}

/**
 * Plays the first legal card if there is one, otherwise draws. Returns false
 * when it was not this page's turn, so a caller can drive both seats without
 * knowing whose move it is.
 *
 * `bringToFront` matters: the two players are tabs in one browser, and
 * Chromium stops firing `requestAnimationFrame` in the background one, which
 * hangs Playwright's actionability check.
 */
export async function takeAnyTurn(page: Page): Promise<boolean> {
  await page.bringToFront();
  await awaitSettled(page);
  if (!(await onTurn(page))) {
    return false;
  }

  const playable = page.locator('.hand .card--playable').first();
  if ((await playable.count()) > 0) {
    await playAnyLegalCard(page);
    return true;
  }
  await page.getByRole('button', { name: /Draw pile, \d+ cards/ }).click();
  return true;
}

/**
 * Plays one legal card, choosing a colour when the card turns out to be a wild.
 *
 * The colour button is looked up *inside the dialog* and matched exactly: a
 * page-wide search for "Red" also matches hand cards named "Play Red 5".
 */
export async function playAnyLegalCard(page: Page): Promise<void> {
  await page.bringToFront();
  const playable = page.locator('.hand .card--playable').first();
  await expect(playable).toBeVisible();
  await playable.click();

  const picker = page.getByRole('dialog');
  try {
    await picker.waitFor({ state: 'visible', timeout: 1000 });
  } catch {
    return; // not a wild card; nothing to choose
  }
  await picker.getByRole('button', { name: 'Red', exact: true }).click();
  await expect(picker).toBeHidden();
}

/**
 * Asserts that a line appears in the game log.
 *
 * The log is a dialog now rather than a panel that permanently occupied a fifth
 * of the table, so reading it is a deliberate act — here as for a player.
 */
export async function expectLogged(page: Page, text: string | RegExp): Promise<void> {
  await page.bringToFront();
  await page.getByRole('button', { name: 'Game log' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.feed__item', { hasText: text }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}
