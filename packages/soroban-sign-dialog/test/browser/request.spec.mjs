// The shared dialog behind `request()`: a request never inherits another's
// per-request fields, and a request whose other parties have not signed gets
// an unknown verdict, not a refusal.
import { test, expect } from '@playwright/test';
import { capture, multiParty, scenario } from '../fixture.mjs';

const TESTNET = 'Test SDF Network ; September 2015';

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/html/');
  await page.evaluate(() => document.querySelector('soroban-sign-dialog')?.remove());
});

test('request() clears the per-request fields the next request leaves out', async ({ page }) => {
  const tx = scenario('within-cap').envelope;
  const entry = capture.scenarios[0].preview.suppliedAuth[0];
  const state = await page.evaluate(async ({ tx, entry, account, passphrase }) => {
    const { request } = await import('/dist/index.js');
    const first = request({ transaction: tx, dapp: 'shop.example', signer: account, network: passphrase, rpcUrl: 'https://rpc.example', theme: 'dark' });
    await new Promise((r) => setTimeout(r));
    const second = request({ authEntries: [entry] });
    await new Promise((r) => setTimeout(r));
    const el = document.querySelector('soroban-sign-dialog[data-shared]');
    const header = el.shadowRoot.querySelector('header').textContent;
    return {
      superseded: (await first).reason,
      network: el.networkPassphrase, signer: el.signer, dapp: el.dapp, transaction: el.transaction, entries: el.authEntries.length,
      rpcUrl: el.rpcUrl, theme: el.getAttribute('theme'), header,
      you: el.shadowRoot.querySelector('[part="entry"]').dataset.mine,
      pending: second instanceof Promise,
    };
  }, { tx, entry, account: capture.addresses.account, passphrase: capture.network.passphrase });
  expect(state.superseded).toBe('superseded');
  expect(state).toMatchObject({ network: TESTNET, signer: null, dapp: null, transaction: null, entries: 1, you: 'false', pending: true });
  expect(state.header).not.toContain('shop.example');
  expect(state.header).toContain('Testnet');
  // Dialog-level configuration persists.
  expect(state).toMatchObject({ rpcUrl: 'https://rpc.example', theme: 'dark' });
});

test('another party has not signed: verdict unknown, no refused flag, recording effects shown', async ({ page }) => {
  const result = await page.evaluate(async ({ ledger, latest, envelope, passphrase, M }) => {
    const { request } = await import('/dist/index.js');
    const { createPreview, fixtureProvider } = await import('/dist/preview/soroban-sim-preview.js');
    const previewProvider = createPreview({ stateProvider: fixtureProvider({ ledger, latest }), hints: { [M.account]: { verifier: M.verifier, key: M.key } } });
    request({ transaction: envelope, network: passphrase, signer: M.account, previewProvider });
    const el = document.querySelector('soroban-sign-dialog[data-shared]');
    const done = new Promise((r) => el.addEventListener('preview', (e) => r(e.detail), { once: true }));
    await el.runPreview();
    const { flags } = await done;
    const root = el.shadowRoot;
    return {
      flags: flags.map((f) => f.kind),
      verdict: root.querySelector('[part="verdict"]').textContent,
      allowed: root.querySelector('[part="verdict"]').dataset.allowed,
      balances: root.querySelectorAll('[part="balances"] tbody tr').length,
      events: root.querySelectorAll('[part="events"] li').length,
      approve: root.querySelector('[data-act="approve"]').textContent,
      status: root.querySelector('[part="status"]').dataset.state,
      reason: root.querySelector('[part="status"]').textContent,
    };
  }, {
    ledger: [...capture.ledger, ...multiParty.ledger],
    latest: { sequence: capture.network.sequence - 1, protocolVersion: 29, closeTime: capture.network.timestamp - 5 },
    envelope: multiParty.envelope, passphrase: capture.network.passphrase, M: multiParty.addresses,
  });
  expect(result.flags).toEqual([]);
  expect(result.allowed).toBe('null');
  expect(result.verdict).toContain('Verdict unknown');
  expect(result.verdict).toContain('Other parties have not signed yet');
  expect(result.balances).toBe(2);
  expect(result.events).toBe(1);
  expect(result.approve).toBe('Approve');
  expect(result.status).toBe('unknown');
  expect(result.reason).toContain('Other parties have not signed yet');
});
