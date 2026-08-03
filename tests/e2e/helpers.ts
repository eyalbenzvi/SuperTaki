import { expect, type Page } from '@playwright/test';

/** Query string that selects the deterministic same-browser transport. */
export const BROADCAST = '?transport=broadcast';

/** Loads the app and switches the UI to English so assertions read clearly. */
export async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await switchToEnglish(page);
}

export async function switchToEnglish(page: Page): Promise<void> {
  const english = page.getByRole('radio', { name: 'English' });
  await english.click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
}

export async function createRoom(page: Page, name: string, maxPlayers = 4): Promise<string> {
  await page.getByRole('button', { name: 'Create game' }).click();
  await page.getByLabel('Your display name').fill(name);
  await page.getByRole('radio', { name: String(maxPlayers), exact: true }).click();
  await page.getByRole('button', { name: 'Create room' }).click();

  const code = page.locator('.code-value').first();
  await expect(code).toBeVisible();
  const roomCode = (await code.textContent())?.trim() ?? '';
  expect(roomCode).toMatch(/^[A-Z]+-[A-Z]+-\d{2}$/);
  return roomCode;
}

export async function joinRoom(page: Page, name: string, roomCode: string): Promise<void> {
  await page.getByRole('button', { name: 'Join game' }).click();
  await page.getByLabel('Your display name').fill(name);
  await page.getByLabel('Invite link or room code').fill(roomCode);
  await page.getByRole('button', { name: 'Join room' }).click();
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
  const onTurn = await page
    .getByText('Your turn')
    .isVisible()
    .catch(() => false);
  if (!onTurn) {
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
