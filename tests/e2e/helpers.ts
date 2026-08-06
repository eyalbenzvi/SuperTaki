import { expect, type Page } from '@playwright/test';

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
 * Whether the draw pile will accept a tap.
 *
 * Read from `aria-disabled`, not from Playwright's `isEnabled()`. The pile refuses
 * with `aria-disabled` so that a blocked tap can explain itself, and `isEnabled()`
 * keys on the `disabled` *property* — so it would report a blocked pile as ready
 * and a driver would click it, collect a refusal, and report that it had moved.
 * The turn check in front of these callers does not cover it: the pile is also
 * blocked while a Taki sequence is open, while a +3 waits, and while a submitted
 * move is unanswered.
 */
export async function canDrawFrom(page: Page): Promise<boolean> {
  const pile = page.locator('.pile button.card--back');
  const state = await pile.getAttribute('aria-disabled').catch(() => 'true');
  return state === 'false';
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

  /*
   * Bounded, and allowed to fail.
   *
   * The pile can stop being clickable between the turn check above and this line: the
   * turn can move, or — when this test has been slow — a robot can take the seat over,
   * which disables every control on it. An unbounded `click()` on a disabled control
   * does not fail, it *waits*, and it waits until the whole test times out. Ten minutes
   * of a stuck click is also far longer than the ninety seconds after which the room
   * covers a silent seat, so the block feeds itself: the seat goes quiet because the
   * click is stuck, a robot takes it, and the click can then never succeed.
   *
   * Returning false tells the caller to look at the table again, which is what it does
   * when it is not our turn anyway. `canDrawFrom` is the check for it — it already knows
   * why `aria-disabled` rather than `isEnabled()` is the question to ask.
   */
  /*
   * A sequence of our own, with nothing left to add to it.
   *
   * The pile is refused while a Taki is open — that is the rule, not a glitch — so a
   * driver that only knows "play a card or draw" has no move here at all. It is our
   * turn, so no robot will break the tie either, and the round stops until the budget
   * runs out. Two of this suite's failures were this state wearing different clothes:
   * first an unbounded click waiting ten minutes on the disabled pile, then, once that
   * was guarded, a spin doing nothing for eight.
   *
   * Closing it is what a player does, and what the room's own test driver does.
   */
  const closeTaki = page.getByRole('button', { name: 'Close Taki' });
  if (await closeTaki.isVisible().catch(() => false)) {
    await closeTaki.click({ timeout: 5_000 });
    return true;
  }

  if (!(await canDrawFrom(page))) {
    return false;
  }
  try {
    await page.getByRole('button', { name: /Draw pile, \d+ cards/ }).click({ timeout: 5_000 });
  } catch {
    return false;
  }
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
