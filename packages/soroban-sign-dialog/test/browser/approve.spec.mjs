// Approve follows the preview: disabled while it runs, a second confirmation
// when it could not simulate (disabled under `strict`), unchanged when no
// preview is configured. Balance rows use the embedder's token labels.
import { test, expect } from '@playwright/test';
import { capture, scenario } from '../fixture.mjs';

const tx = scenario('within-cap').envelope;
const passphrase = capture.network.passphrase;

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/html/');
  await page.evaluate(() => document.querySelector('soroban-sign-dialog')?.remove());
});

// Open a request with the named `provider` (or none) and
// report the Approve button and warnings once the preview has settled.
const open = (page, { provider, strict = false, strings, clicks = 0 }) => page.evaluate(async ({ tx, passphrase, provider, strict, strings, clicks }) => {
  const { request } = await import('/dist/index.js');
  const providers = {
    pending: () => new Promise(() => {}),
    error: async () => { throw new Error('muxed source'); },
    'fee-bump': async () => ({ status: 'fallback', code: 'fee-bump', params: {} }),
    unsupported: async () => ({ status: 'unsupported' }),
    protocol: async () => ({ status: 'fallback', code: 'protocol', params: { protocol: 31, builds: [29, 30] } }),
  };
  const previewProvider = provider ? providers[provider] : undefined;
  const result = request({ transaction: tx, network: passphrase, previewProvider, strict, strings });
  const el = document.querySelector('soroban-sign-dialog[data-shared]');
  const approved = new Promise((r) => el.addEventListener('approve', (e) => r(e.detail.flags), { once: true }));
  await new Promise((r) => setTimeout(r, 50));
  const button = () => el.shadowRoot.querySelector('[data-act="approve"]');
  const state = { disabled: button().disabled, label: button().textContent, status: el.shadowRoot.querySelector('[part="status"]').dataset.state,
    warnings: [...el.shadowRoot.querySelectorAll('[part="warning"]')].map((w) => w.textContent) };
  const labels = [];
  for (let i = 0; i < clicks; i++) { button().click(); await new Promise((r) => setTimeout(r, 10)); labels.push(button()?.textContent ?? null); }
  const flags = clicks ? await Promise.race([approved, new Promise((r) => setTimeout(() => r(null), 200))]) : null;
  if (el.open) el.close();
  await result;
  return { ...state, labels, flags };
}, { tx, passphrase, provider, strict, strings, clicks });

test('Approve is disabled while the preview runs', async ({ page }) => {
  const s = await open(page, { provider: 'pending' });
  expect(s.status).toBe('checking');
  expect(s.disabled).toBe(true);
});

test('a failed preview needs a second confirmation and reports the condition', async ({ page }) => {
  const s = await open(page, { provider: 'error', clicks: 2 });
  expect(s.disabled).toBe(false);
  expect(s.label).toBe('Approve anyway');
  expect(s.warnings).toEqual(['This request could not be simulated. Approve anyway?']);
  expect(s.labels[0]).toBe('Confirm: approve anyway');
  expect(s.flags).toEqual([{ kind: 'not-simulated', code: 'error' }]);
});

test('a tree-only fallback needs a second confirmation, with overridable text', async ({ page }) => {
  const s = await open(page, {
    provider: 'fee-bump',
    strings: { notSimulatedWarning: 'Not simulated.' },
    clicks: 1,
  });
  expect(s.disabled).toBe(false);
  expect(s.warnings).toEqual(['Not simulated.']);
  expect(s.labels).toEqual(['Confirm: approve anyway']);
  expect(s.flags).toBeNull();
});

test('under strict, an error or fallback keeps Approve disabled', async ({ page }) => {
  for (const provider of ['error', 'protocol']) {
    const s = await open(page, { provider, strict: true });
    expect(s.disabled, provider).toBe(true);
  }
});

test('a status outside the documented set fails closed', async ({ page }) => {
  const s = await open(page, { provider: 'unsupported', clicks: 1 });
  expect(s).toMatchObject({ status: 'unknown', disabled: false, label: 'Approve anyway', labels: ['Confirm: approve anyway'], flags: null });
  expect(s.warnings).toEqual(['This request could not be simulated. Approve anyway?']);
  expect((await open(page, { provider: 'unsupported', strict: true })).disabled).toBe(true);
});

test('without a preview provider, Approve is unchanged', async ({ page }) => {
  const s = await open(page, { provider: null, clicks: 1 });
  expect(s).toMatchObject({ disabled: false, label: 'Approve', warnings: [], flags: [] });
});

test('balance rows use the labelled token for a contract the provider did not know', async ({ page }) => {
  const usdc = capture.addresses.verifier;
  const row = await page.evaluate(async ({ tx, passphrase, usdc, holder }) => {
    const { request } = await import('/dist/index.js');
    const previewProvider = async () => ({
      status: 'ok', outcome: { ok: true, error: null, codes: [] }, verdicts: [], budgets: [], events: [],
      balances: [{ address: holder, asset: { code: 'CAAA…', decimals: 0, contract: usdc }, before: '0', after: '10000000' }],
    });
    request({ transaction: tx, network: passphrase, previewProvider, labels: { [usdc]: { name: 'USD Coin', token: { code: 'USDC', decimals: 7 } } } });
    const el = document.querySelector('soroban-sign-dialog[data-shared]');
    await new Promise((r) => setTimeout(r, 50));
    const cells = [...el.shadowRoot.querySelectorAll('[part="balances"] tbody td')].map((c) => c.textContent);
    el.close();
    return cells;
  }, { tx, passphrase, usdc, holder: capture.addresses.shop });
  expect(row[1]).toBe('USDC');
  expect(row[4]).toBe('+1');
});
