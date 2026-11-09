// The preview engine end to end: the real reactor builds (dist/preview, from
// `pnpm build`) against the captured Perch ledger, for the within-cap,
// over-cap and unused-entry scenarios, plus the protocol gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { preview, fixtureProvider, BUILDS } from '../src/preview/soroban-sim-preview.js';
import { compareAuth, decodeAuthEntry, decodeEnvelope } from '../src/xdr.js';
import { capture, scenario } from './fixture.mjs';

const A = capture.addresses;
const wasmPath = (p) => new URL(`../dist/preview/${BUILDS[p].wasm}`, import.meta.url);
for (const p of Object.keys(BUILDS)) {
  if (!existsSync(wasmPath(p))) throw new Error(`missing ${wasmPath(p).pathname}: run \`pnpm build\` first`);
}

const ledger = (protocolVersion) => fixtureProvider({
  ledger: capture.ledger,
  latest: { sequence: capture.network.sequence - 1, protocolVersion, closeTime: capture.network.timestamp - 5 },
});
const hints = { [A.account]: { verifier: A.verifier, key: A.appKey, grantId: 1, ruleId: A.spendRuleId } };

// The fixture was captured on protocol 29. Its entries are valid protocol-30
// state too, so the protocol-30 build runs it as if the network had upgraded.
const run = (id, protocol = 29, extra = {}) => preview({
  transaction: scenario(id).envelope,
  networkPassphrase: capture.network.passphrase,
  stateProvider: ledger(protocol),
  hints,
  inline: true,
  wasm: (p) => readFileSync(wasmPath(p)),
  ...extra,
});

const xlm = (n) => String(BigInt(Math.round(n * 1e7)));
const statuses = (id, r) => compareAuth(decodeEnvelope(scenario(id).envelope).tx.operations[0].auth, r.recordedAuth.map(decodeAuthEntry)).entries.map((e) => e.status);

for (const protocol of [29, 30]) {
  test(`p${protocol}: within the cap, accepted and 2 XLM left`, async () => {
    const r = await run('within-cap', protocol);
    assert.equal(r.status, 'ok');
    assert.equal(r.engine.protocol, protocol);
    assert.equal(r.timings.engine.hostProtocol, protocol);
    assert.deepEqual(statuses('within-cap', r), ['match']);
    assert.equal(r.verdicts.length, 1);
    assert.equal(r.verdicts[0].allowed, true);
    assert.equal(r.verdicts[0].reasonCode, 'accepted');
    assert.equal(r.verdicts[0].rule.name, 'spend');
    assert.deepEqual(r.budgets.map((b) => [b.limit, b.spentInWindow, b.amount]), [[xlm(10), xlm(3), xlm(5)]]);
    assert.ok(r.outcome.ok);
    const change = Object.fromEntries(r.balances.map((b) => [b.address, BigInt(b.after) - BigInt(b.before)]));
    assert.equal(change[A.account], -50_000_000n);
    assert.equal(change[A.shop], 50_000_000n);
    assert.equal(r.events.length, 1);
    assert.equal(r.timings.stateCalls, 2, 'one batch plus the header: a single round trip');
  });

  test(`p${protocol}: over the cap, refused with contract error 5`, async () => {
    const r = await run('over-cap', protocol);
    assert.equal(r.status, 'ok');
    assert.deepEqual(statuses('over-cap', r), ['match']);
    assert.equal(r.verdicts[0].allowed, false);
    assert.equal(r.verdicts[0].code, 5);
    assert.equal(r.verdicts[0].reasonCode, 'refused-over-cap');
    assert.deepEqual(r.budgets.map((b) => [b.spentInWindow, b.amount]), [[xlm(3), xlm(8)]]);
    assert.deepEqual(r.balances, [], 'a refused transaction moves nothing');
  });

  test(`p${protocol}: an entry the transaction never uses is flagged`, async () => {
    const r = await run('unused-entry', protocol);
    assert.equal(r.status, 'ok');
    assert.equal(r.recordedAuth.length, 1);
    assert.deepEqual(statuses('unused-entry', r), ['match', 'extra']);
    assert.equal(r.verdicts[0].allowed, true);
    // Only the entry the transaction consumes counts against the cap.
    assert.deepEqual(r.budgets.map((b) => b.amount), [xlm(2)]);
    const change = Object.fromEntries(r.balances.map((b) => [b.address, BigInt(b.after) - BigInt(b.before)]));
    assert.equal(change[A.shop], 20_000_000n);
    assert.equal(change[A.other], undefined);
  });
}

test('a protocol with no build falls back to the tree, without loading a reactor', async () => {
  let loaded = false;
  const r = await run('within-cap', 31, { wasm: () => { loaded = true; } });
  assert.equal(r.status, 'fallback');
  assert.equal(r.code, 'protocol');
  assert.deepEqual(r.params, { protocol: 31, builds: [29, 30] });
  assert.match(r.notice, /protocol 31/);
  assert.equal(loaded, false);
});

test('a build that reports another protocol is refused', async () => {
  await assert.rejects(run('within-cap', 30, { wasm: () => readFileSync(wasmPath(29)), inline: true, stateProvider: ledger(30) }), /reports protocol 29/);
});

test('without a hint, the account is not evaluated and says so', async () => {
  const r = await run('within-cap', 29, { hints: {} });
  assert.equal(r.status, 'ok');
  assert.equal(r.code, 'no-hint');
  assert.deepEqual(r.verdicts, []);
});

test('bare auth entries and missing state sources fall back', async () => {
  assert.equal((await preview({ networkPassphrase: capture.network.passphrase })).code, 'no-transaction');
  assert.equal((await preview({ transaction: scenario('within-cap').envelope, networkPassphrase: 'Some Private Network' })).code, 'no-rpc');
});
