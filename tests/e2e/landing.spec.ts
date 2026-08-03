import { expect, test } from '@playwright/test';

test.describe('landing screen', () => {
  test('opens in Hebrew with right-to-left layout', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'he');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('button', { name: 'פתיחת משחק' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'הצטרפות למשחק' })).toBeVisible();
  });

  test('switches to English and back', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('button', { name: 'Create game' })).toBeVisible();

    await page.getByRole('radio', { name: 'עברית' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('remembers the language after a reload', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'English' }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('switches theme and remembers it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'כהה' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('radio', { name: 'בהיר' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('shows the honest connectivity and privacy notes', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'English' }).click();
    await expect(page.getByText('Players connect directly to each other')).toBeVisible();
    await expect(page.getByText('No accounts, no servers, no analytics')).toBeVisible();
    await expect(page.getByText('not affiliated with or endorsed by')).toBeVisible();
  });

  test('opens the rules page and returns', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'English' }).click();
    await page.getByRole('button', { name: 'How to play' }).click();

    await expect(page.getByRole('heading', { name: 'How to play Color Rush' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Taki sequences' })).toBeVisible();
    await expect(page.getByText('Colourless cards (Colour Change, Super Taki) cannot')).toBeVisible();

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('button', { name: 'Create game' })).toBeVisible();
  });

  test('reaches the rules page from a deep link', async ({ page }) => {
    await page.goto('/#/rules');
    await expect(page.getByRole('heading', { name: 'איך משחקים קולור ראש' })).toBeVisible();
  });

  test('is reachable by keyboard only', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'דלג לתוכן הראשי' })).toBeFocused();

    // Walk forwards until the create button takes focus.
    const create = page.getByRole('button', { name: 'פתיחת משחק' });
    for (let i = 0; i < 15 && !(await create.evaluate((el) => el === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(create).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'פתיחת משחק' })).toBeVisible();
  });

  test('stays usable at 320px wide', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const button = page.getByRole('button', { name: 'פתיחת משחק' });
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
