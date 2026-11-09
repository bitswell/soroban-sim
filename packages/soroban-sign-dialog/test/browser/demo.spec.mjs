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

const status = (page) => page.locator('soroban-sign-dialog [part="status"]');
const details = (page) => page.locator('soroban-sign-dialog [part="details"]');

// The preview runs on open; wait until the status settles.
async function order(page, scenario, { preview = true } = {}) {
  if (!preview) await page.selectOption('#preview', 'off');
  await page.locator(`[data-scenario="${scenario}"]`).click();
  await expect(dialog(page)).toHaveAttribute('open');
  if (preview) await expect(status(page)).not.toHaveAttribute('data-state', /checking|idle/, { timeout: 30_000 });
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
  await expect(page.locator('soroban-sign-dialog [part="what"] li')).toHaveText(['Send 5 XLM to Corner Café GCUV…5HPY']);
  await expect(page.locator('soroban-sign-dialog [part="budget-line"]')).toHaveText('2 of 10 XLM left this window after this');
  await expect(status(page)).toHaveAttribute('data-state', 'success');
  await expect(status(page)).toContainText('Will succeed');
  await expect(page.locator('soroban-sign-dialog [part="warning"]')).toHaveCount(0);
  // The evidence sits behind one disclosure, closed by default.
  await expect(details(page)).not.toHaveAttribute('open');
  await page.locator('soroban-sign-dialog [part="details-summary"]').click();
  const p = page.locator('soroban-sign-dialog [part="preview"]');
  await expect(p.locator('[part="auth-check"]')).toContainText('recorded the same authorization tree');
  await expect(p.locator('[part="verdict"]')).toContainText('Would be accepted');
  await expect(p.locator('[part="budget"]')).toContainText('After this: 2 XLM left');
  await expect(p.locator('[part="balances"]')).toContainText('−5');
  await expect(p.locator('[part="events"] li')).toHaveCount(1);
  await expect(approve(page)).toHaveText('Approve');
  await approve(page).click();
  await expect(page.locator('#log .ev').first()).toHaveAttribute('data-result', 'approved');
});

test('over the cap: refused, and Approve needs a second click', async ({ page }) => {
  await order(page, 'over-cap');
  await expect(status(page)).toHaveAttribute('data-state', 'refused');
  await expect(status(page)).toContainText('Will be refused');
  await expect(status(page)).toContainText('more than the cap has left');
  await expect(page.locator('soroban-sign-dialog [part="budget-line"]')).toHaveText('Over the cap: 7 of 10 XLM left this window');
  await expect(approve(page)).toHaveText('Approve anyway');
});

test('an entry the transaction never uses is marked', async ({ page }) => {
  await order(page, 'unused-entry');
  await expect(page.locator('soroban-sign-dialog [part="what"] li').nth(1)).toContainText('Send 4 XLM to Another address');
  await expect(page.locator('soroban-sign-dialog [part="what"] li').nth(1)).toContainText('not used');
  await expect(page.locator('soroban-sign-dialog [part="warning"]')).toContainText('does not use: Send 4 XLM to Another address');
  await expect(page.locator('soroban-sign-dialog [part="warning"]')).toContainText('anyone can submit that authorization later');
  await expect(page.locator('soroban-sign-dialog [part="budget-line"]')).toHaveText('5 of 10 XLM left this window after this');
  await page.locator('soroban-sign-dialog [part="details-summary"]').click();
  const entries = page.locator('soroban-sign-dialog [part="entry"]');
  await expect(entries.nth(0)).toHaveAttribute('data-status', 'match');
  await expect(entries.nth(1)).toHaveAttribute('data-status', 'extra');
  await expect(entries.nth(1)).toContainText('Not used by this transaction');
  await expect(entries.nth(1).locator('[part="unused-entry"]')).toContainText('anyone can submit it later');
  await approve(page).click();
  await expect(approve(page)).toHaveText('Confirm: approve anyway');
  await approve(page).click();
  await expect(page.locator('#log .ev').first()).toContainText('Signed despite: extra');
});

test('the protocol-30 build runs a protocol-30 ledger', async ({ page }) => {
  await page.selectOption('#source', 'fixture-30');
  await order(page, 'within-cap');
  await expect(status(page)).toHaveAttribute('data-state', 'success');
  await expect(page.locator('soroban-sign-dialog [part="preview"]')).toContainText('protocol 30');
});

test('a protocol with no build falls back to the tree', async ({ page }) => {
  await page.selectOption('#source', 'fixture-31');
  await order(page, 'within-cap');
  await expect(status(page)).toHaveAttribute('data-state', 'unknown');
  await expect(status(page)).toContainText('The network is on protocol 31');
  await expect(status(page)).toContainText('still exact');
  await expect(page.locator('soroban-sign-dialog [part="what"] li')).toHaveText(['Send 5 XLM to Corner Café GCUV…5HPY']);
  // Not simulated: Approve stays available behind a second confirmation.
  await expect(page.locator('soroban-sign-dialog [part="warning"]')).toHaveText('This request could not be simulated. Approve anyway?');
  await expect(approve(page)).toHaveText('Approve anyway');
  await approve(page).click();
  await expect(approve(page)).toHaveText('Confirm: approve anyway');
  await approve(page).click();
  await expect(page.locator('#log .ev').first()).toContainText('Signed despite: not-simulated');
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
  await expect(page.locator('soroban-sign-dialog [part="what"] li')).toContainText('Enviar 5 XLM a Corner Café');
  await expect(page.locator('soroban-sign-dialog [part="details-summary"]')).toHaveText('Detalles');
  await expect(approve(page)).toHaveText('Aprobar');
  expect(await dialog(page).evaluate((d) => getComputedStyle(d).borderTopLeftRadius)).toBe('20px');
});

test('preview="manual" waits for the user to ask', async ({ page }) => {
  await page.selectOption('#preview', 'manual');
  await page.locator('[data-scenario="within-cap"]').click();
  await expect(status(page)).toHaveAttribute('data-state', 'idle');
  await page.locator('soroban-sign-dialog [data-act="preview"]').click();
  await expect(status(page)).toHaveAttribute('data-state', 'success', { timeout: 30_000 });
});

test('Details stays open across the preview finishing', async ({ page }) => {
  await page.selectOption('#source', 'fixture');
  await page.locator('[data-scenario="within-cap"]').click();
  await page.locator('soroban-sign-dialog [part="details-summary"]').click();
  await expect(status(page)).toHaveAttribute('data-state', 'success', { timeout: 30_000 });
  await expect(details(page)).toHaveAttribute('open');
});
