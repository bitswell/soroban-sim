// The preview engine end to end: the real reactor builds (dist/preview, from
// `pnpm build`) against the captured Perch ledger, for the within-cap,
// over-cap and unused-entry scenarios, a two-party request, and the protocol
// gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { preview, fixtureProvider, BUILDS } from '../src/preview/soroban-sim-preview.js';
import { perchAdapter } from '../src/preview/perch.js';
import { compareAuth, decodeAuthEntry, decodeEnvelope, decodeLedgerEntry } from '../src/xdr.js';
import { capture, multiParty, scenario } from './fixture.mjs';

const A = capture.addresses;
const wasmPath = (p) => new URL(`../dist/preview/${BUILDS[p].wasm}`, import.meta.url);
for (const p of Object.keys(BUILDS)) {
  if (!existsSync(wasmPath(p))) throw new Error(`missing ${wasmPath(p).pathname}: run \`pnpm build\` first`);
}

const ledger = (protocolVersion, extra = []) => fixtureProvider({
  ledger: [...capture.ledger, ...extra],
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
    assert.ok(r.outcome.codes.some((c) => c.contract === A.account && c.code === 5), 'the account raised the error');
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

test('each preview sees only its own state, one at a time per engine', async () => {
  // One wasm source, so every preview here shares one cached engine.
  const wasm = (p) => readFileSync(wasmPath(p));
  const first = await run('within-cap', 29, { wasm });
  const again = await run('within-cap', 29, { wasm });
  assert.ok(first.timings.roundKeys.length > 0, 'the recording asks for its fresh nonce keys');
  assert.deepEqual(again.timings.roundKeys, first.timings.roundKeys, 'the second preview starts from an empty store');

  // Concurrent previews on that engine keep their own verdicts and effects.
  const slow = fixtureProvider({ ledger: capture.ledger, latency: 5, latest: { sequence: capture.network.sequence - 1, protocolVersion: 29, closeTime: capture.network.timestamp - 5 } });
  const [over, within] = await Promise.all([run('over-cap', 29, { wasm, stateProvider: slow }), run('within-cap', 29, { wasm, stateProvider: slow })]);
  assert.equal(over.verdicts[0].reasonCode, 'refused-over-cap');
  assert.deepEqual(over.balances, []);
  assert.equal(within.verdicts[0].allowed, true);
  assert.equal(within.balances.length, 2);
});

for (const protocol of [29, 30]) {
  test(`p${protocol}: another party has not signed, so the verdict is unknown and the recording shows the effects`, async () => {
    const M = multiParty.addresses;
    const r = await preview({
      transaction: multiParty.envelope,
      networkPassphrase: capture.network.passphrase,
      stateProvider: ledger(protocol, multiParty.ledger),
      hints: { [M.account]: { verifier: M.verifier, key: M.key } },
      inline: true,
      wasm: (p) => readFileSync(wasmPath(p)),
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.recordedAuth.length, 2);
    assert.equal(r.verdicts.length, 1);
    assert.equal(r.verdicts[0].allowed, null);
    assert.equal(r.verdicts[0].reasonCode, 'unsigned-others');
    assert.ok(r.outcome.ok, 'the outcome is the recording’s');
    const change = Object.fromEntries(r.balances.map((b) => [b.address, BigInt(b.after) - BigInt(b.before)]));
    assert.equal(change[M.cosigner], -10_000_000n);
    assert.equal(change[M.shop], 10_000_000n);
    assert.equal(r.events.length, 1);
  });
}

test('a failed recording leaves the used/unused comparison unknown', async () => {
  // Without the account's XLM balance the token contract fails the transfer,
  // so the recording produces no tree to compare the supplied entries with.
  const isBalance = (d) => d.type === 'contract-data' && d.contract.str === A.nativeSac && d.key.t === 'vec' && d.key.v[0].v === 'Balance' && d.key.v[1].str === A.account;
  const broke = fixtureProvider({
    ledger: capture.ledger.filter((e) => !isBalance(decodeLedgerEntry(e.entry))),
    latest: { sequence: capture.network.sequence - 1, protocolVersion: 29, closeTime: capture.network.timestamp - 5 },
  });
  const r = await run('within-cap', 29, { hints: {}, stateProvider: broke });
  assert.equal(r.status, 'ok');
  assert.equal(r.outcome.ok, false);
  assert.ok(r.outcome.codes.some((c) => c.contract === A.nativeSac && c.code === 10));
  assert.equal(r.recordedAuth, null, 'no recorded tree, so no entry is marked unused');
});

test('a contract error is the account’s refusal only when the account raised it', () => {
  const op = decodeEnvelope(scenario('within-cap').envelope).tx.operations[0];
  const perch = perchAdapter(A.account, hints[A.account]);
  const failed = (contract, code) => ({ ok: false, error: 'Error(Auth, InvalidAction)', codes: [{ contract, code }] });
  // Another contract's error 3 is not Perch's "stale grant".
  const elsewhere = perch.verdict(op, failed(A.nativeSac, 3), { ok: false }, capture.network.sequence);
  assert.equal(elsewhere.allowed, null);
  assert.equal(elsewhere.reasonCode, 'failed');
  const own = perch.verdict(op, failed(A.account, 3), { ok: false }, capture.network.sequence);
  assert.equal(own.allowed, false);
  assert.equal(own.code, 3);
  assert.equal(own.reasonCode, 'refused');
  assert.equal(own.params.cause, 'a stale grant');
});

test('unsigned others only when another party’s entry has no signature yet', () => {
  const M = multiParty.addresses;
  const op = decodeEnvelope(multiParty.envelope).tx.operations[0];
  const perch = perchAdapter(M.account, { verifier: M.verifier, key: M.key });
  const enforce = { ok: false, error: 'Error(Auth, InvalidAction)', codes: [] };
  const unsigned = perch.verdict(op, enforce, { ok: true }, capture.network.sequence);
  assert.equal(unsigned.allowed, null);
  assert.equal(unsigned.reasonCode, 'unsigned-others');
  // The cosigner has signed: the failure is not theirs to explain.
  const signed = { ...op, auth: op.auth.map((e) => (e.credentials.address?.str === M.cosigner ? { ...e, credentials: { ...e.credentials, signature: { t: 'vec', v: [] } } } : e)) };
  const failed = perch.verdict(signed, enforce, { ok: true }, capture.network.sequence);
  assert.equal(failed.allowed, null);
  assert.equal(failed.reasonCode, 'failed');
});
