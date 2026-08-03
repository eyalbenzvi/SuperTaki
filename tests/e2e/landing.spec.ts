import { expect, test } from '@playwright/test';
import { openSettings } from './helpers.ts';

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
    await openSettings(page);
    await page.getByRole('radio', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('button', { name: 'Create game' })).toBeVisible();

    await page.getByRole('radio', { name: 'עברית' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('remembers the language after a reload', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await page.getByRole('radio', { name: 'English' }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('switches theme and remembers it', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await page.getByRole('radio', { name: 'כהה' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('radio', { name: 'בהיר' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('shows the wordmark, the two ways in, and settings', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('סופר טאקי');
    await expect(page.getByRole('button')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'הגדרות' })).toBeVisible();
  });

  test('is reachable by keyboard only', async ({ page }) => {
    await page.goto('/');
    // Wait for the shell before pressing anything: a Tab that lands before React
    // has attached goes to the document, not to the skip link.
    await expect(page.getByRole('button', { name: 'פתיחת משחק' })).toBeVisible();
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
