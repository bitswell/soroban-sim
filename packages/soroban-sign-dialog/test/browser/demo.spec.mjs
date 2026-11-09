// The demo page end to end: the embed, the real engine in a Worker against
// the captured ledger, under a CSP with no inline script or style.
import { test, expect } from '@playwright/test';

const dialog = (page) => page.locator('soroban-sign-dialog dialog');
const approve = (page) => page.locator('soroban-sign-dialog button[data-act="approve"]');

test.beforeEach(async ({ page }) => {
  page.csp = [];
  page.on('console', (m) => { if (/Content.Security.Policy|Refused to/i.test(m.text())) page.csp.push(m.text()); });
  await page.goto('/demo/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
});

test.afterEach(async ({ page }) => {
  expect(page.csp).toEqual([]);
});

async function order(page, scenario, { preview = true } = {}) {
  await page.locator(`[data-scenario="${scenario}"]`).click();
  await expect(dialog(page)).toHaveAttribute('open');
  if (preview) {
    await page.locator('soroban-sign-dialog [data-act="preview"]').click();
    await expect(page.locator('soroban-sign-dialog [part="preview"]')).toContainText(/Simulated locally|protocol/, { timeout: 30_000 });
  }
}

test('styles apply under the strict CSP, with focus on Reject and the logo slot', async ({ page }) => {
  await order(page, 'within-cap', { preview: false });
  const radius = await dialog(page).evaluate((d) => getComputedStyle(d).borderTopLeftRadius);
  expect(radius).toBe('12px');
  await expect(page.locator('soroban-sign-dialog button[data-act="reject"]')).toBeFocused();
  await expect(page.locator('soroban-sign-dialog img[slot="logo"]')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Authorize this call' })).toBeVisible();
});

test('within the cap: matches, accepted, budget and balances', async ({ page }) => {
  await order(page, 'within-cap');
  const p = page.locator('soroban-sign-dialog [part="preview"]');
  await expect(p.locator('[part="auth-check"]')).toContainText('recorded the same authorization tree');
  await expect(p.locator('[part="verdict"]')).toContainText('Would be accepted');
  await expect(p.locator('[part="budget"]')).toContainText('7 XLM of 10 XLM left');
  await expect(p.locator('[part="budget"]')).toContainText('After this: 2 XLM left');
  await expect(p.locator('[part="balances"]')).toContainText('−5');
  await expect(approve(page)).toHaveText('Sign');
  await approve(page).click();
  await expect(page.locator('#log .ev').first()).toHaveAttribute('data-result', 'approved');
});

test('over the cap: refused, and Sign needs a second click', async ({ page }) => {
  await order(page, 'over-cap');
  await expect(page.locator('soroban-sign-dialog [part="verdict"]')).toContainText('Would be refused');
  await expect(page.locator('soroban-sign-dialog [part="verdict"]')).toContainText('more than the cap has left');
  await expect(page.locator('soroban-sign-dialog [part="budget"]')).toContainText('over the remaining cap');
  await expect(approve(page)).toHaveText('Sign anyway');
});

test('an entry the transaction never uses is marked', async ({ page }) => {
  await order(page, 'unused-entry');
  const entries = page.locator('soroban-sign-dialog [part="entry"]');
  await expect(entries.nth(0)).toHaveAttribute('data-status', 'match');
  await expect(entries.nth(1)).toHaveAttribute('data-status', 'extra');
  await expect(entries.nth(1)).toContainText('Not used by this transaction');
  await expect(entries.nth(1).locator('[part="unused-entry"]')).toContainText('anyone can submit it later');
  await expect(page.locator('soroban-sign-dialog [part="budget"]')).toContainText('After this: 5 XLM left');
  await approve(page).click();
  await expect(approve(page)).toHaveText('Confirm: sign anyway');
  await approve(page).click();
  await expect(page.locator('#log .ev').first()).toContainText('Signed despite: extra');
});

test('the protocol-30 build runs a protocol-30 ledger', async ({ page }) => {
  await page.selectOption('#source', 'fixture-30');
  await order(page, 'within-cap');
  await expect(page.locator('soroban-sign-dialog [part="verdict"]')).toContainText('Would be accepted');
  await expect(page.locator('soroban-sign-dialog [part="preview"]')).toContainText('protocol 30');
});

test('a protocol with no build falls back to the tree', async ({ page }) => {
  await page.selectOption('#source', 'fixture-31');
  await order(page, 'within-cap');
  await expect(page.locator('soroban-sign-dialog [part="notice"]')).toContainText('The network is on protocol 31');
  await expect(page.locator('soroban-sign-dialog [part="notice"]')).toContainText('still exact');
  await expect(approve(page)).toHaveText('Sign');
});

test('Escape rejects as dismissed', async ({ page }) => {
  await order(page, 'within-cap', { preview: false });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).not.toHaveAttribute('open');
  await expect(page.locator('#log .ev').first()).toHaveAttribute('data-result', 'dismissed');
});

test('strings and tokens are the wallet\'s to change', async ({ page }) => {
  await page.selectOption('#lang', 'es');
  await page.selectOption('#look', 'brand');
  await order(page, 'within-cap', { preview: false });
  await expect(page.getByRole('dialog', { name: 'Autoriza esta llamada' })).toBeVisible();
  await expect(page.locator('soroban-sign-dialog .sentence')).toContainText('Enviar 5 XLM');
  await expect(approve(page)).toHaveText('Firmar');
  expect(await dialog(page).evaluate((d) => getComputedStyle(d).borderTopLeftRadius)).toBe('20px');
});
