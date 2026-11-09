// Each framework mounts the dialog with rich data passed as properties and
// receives approve and reject as CustomEvents.
import { test, expect } from '@playwright/test';

const PAGES = {
  'plain HTML': '/examples/html/',
  'React 18': '/.tmp/examples/react18.html',
  'React 19': '/.tmp/examples/react19.html',
  'Vue 3': '/.tmp/examples/vue.html',
  'Svelte 5': '/.tmp/examples/svelte.html',
  Angular: '/.tmp/examples/angular.html',
};

for (const [name, url] of Object.entries(PAGES)) {
  test.describe(name, () => {
    test.beforeEach(async ({ page }) => {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url);
      await expect(page.locator('soroban-sign-dialog dialog[open]')).toBeVisible();
      expect(errors).toEqual([]);
    });

    test('renders labels passed as a property, and a slot', async ({ page }) => {
      // An object stringified into an attribute would leave raw addresses.
      await expect(page.locator('soroban-sign-dialog [part="what"]')).toContainText('Send 5 XLM to Corner Café');
      await expect(page.locator('soroban-sign-dialog [part="tree"] .sentence')).toContainText('Send 5 XLM from Your account (you)');
      await expect(page.getByText('Signed with Acme Wallet')).toBeVisible();
    });

    test('approve carries the entries to sign', async ({ page }) => {
      await page.locator('soroban-sign-dialog button[data-act="approve"]').click();
      await expect(page.locator('body')).toHaveAttribute('data-result', 'approved:1');
      await expect(page.locator('soroban-sign-dialog dialog')).not.toHaveAttribute('open');
    });

    test('reject reports the reason', async ({ page }) => {
      await page.locator('soroban-sign-dialog button[data-act="reject"]').click();
      await expect(page.locator('body')).toHaveAttribute('data-result', 'rejected:rejected');
    });
  });
}
