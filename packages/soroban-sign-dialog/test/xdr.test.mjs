// The decoder against real XDR from the captured fixture, and against
// malformed input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  decodeEnvelope, decodeAuthEntry, decodeEvent, decodeLedgerEntry, decodeLedgerKey, decodeScVal,
  nativeAssetContract, formatAmount, fromStrkey, strkeyFor, authPayloadHash, transactionHash, XdrError,
} from '../src/xdr.js';
import { capture } from './fixture.mjs';

const A = capture.addresses;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

test('derives the native asset contract from the passphrase', async () => {
  assert.equal(await nativeAssetContract(capture.network.passphrase), A.nativeSac);
  assert.notEqual(await nativeAssetContract('Test SDF Network ; September 2015'), A.nativeSac);
});

test('decodes each scenario envelope', () => {
  for (const s of capture.scenarios) {
    const env = decodeEnvelope(s.envelope);
    assert.equal(env.tx.source.str, A.payer, s.id);
    assert.equal(env.feeBump, null);
    const [op] = env.tx.operations;
    assert.equal(op.type, 'invoke');
    assert.equal(op.hostFunction.contract.str, A.nativeSac);
    assert.equal(op.hostFunction.fn, 'transfer');
    assert.deepEqual(op.hostFunction.args.map((a) => a.str ?? a.v), [A.account, A.shop, BigInt(s.amountXlm) * 10_000_000n]);
    assert.equal(op.auth.length, s.preview.suppliedAuth.length);
    assert.ok(env.tx.soroban.readWrite.length > 0);
    for (const k of [...env.tx.soroban.readOnly, ...env.tx.soroban.readWrite]) assert.equal(decodeLedgerKey(k.xdr).xdr, k.xdr);
  }
});

test('the unused entry decodes as a second transfer to another address', () => {
  const [, extra] = decodeEnvelope(capture.scenarios.find((s) => s.id === 'unused-entry').envelope).tx.operations[0].auth;
  assert.equal(extra.credentials.type, 'address');
  assert.equal(extra.credentials.address.str, A.account);
  assert.equal(extra.root.fn.fn, 'transfer');
  assert.equal(extra.root.fn.args[1].str, A.other);
  assert.equal(extra.root.fn.args[2].v, 40_000_000n);
});

test('decodes every ledger entry, with code hashes that match the code', () => {
  let code = 0;
  for (const { entry } of capture.ledger) {
    const e = decodeLedgerEntry(entry);
    if (e.type === 'contract-code') {
      code++;
      assert.equal(e.hash, createHash('sha256').update(e.code).digest('hex'));
    }
  }
  assert.ok(code >= 3, 'the fixture holds the account, verifier and helper code');
});

test('decodes events and signed payloads', () => {
  const s = capture.scenarios.find((x) => x.id === 'within-cap');
  const ev = decodeEvent(s.preview.events[0]);
  assert.equal(ev.contract.str, A.nativeSac);
  assert.deepEqual(ev.topics.slice(0, 3).map((t) => t.v ?? t.str), ['transfer', A.account, A.shop]);
  const signed = decodeAuthEntry(s.preview.signedAuth[0]);
  assert.deepEqual(signed.credentials.signature.v.map((e) => e.k.v), ['context_rule_ids', 'signers']);
});

test('hashes what is signed', async () => {
  const s = capture.scenarios[0];
  const env = decodeEnvelope(s.envelope);
  assert.equal((await transactionHash(env, capture.network.passphrase)).length, 32);
  const a = await authPayloadHash(env.tx.operations[0].auth[0], capture.network.passphrase);
  const b = await authPayloadHash(env.tx.operations[0].auth[0], capture.network.passphrase, 1);
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b, 'the expiration ledger is part of the payload');
});

test('StrKeys round-trip and reject bad checksums', () => {
  for (const s of [A.account, A.payer, A.verifier]) assert.equal(strkeyFor(s[0] === 'G' ? 'account' : 'contract', fromStrkey(s)), s);
  assert.throws(() => fromStrkey(A.account.slice(0, -1) + (A.account.endsWith('A') ? 'B' : 'A')), XdrError);
  assert.throws(() => fromStrkey('not a key'), XdrError);
});

test('formats amounts', () => {
  assert.equal(formatAmount(50_000_000n, 7), '5');
  assert.equal(formatAmount(-12_345_678n, 7), '−1.2345678');
  assert.equal(formatAmount(123456789012345n, 7), '12,345,678.9012345');
  assert.equal(formatAmount(0n, 7), '0');
  assert.equal(formatAmount(42n, 0), '42');
});

test('refuses malformed XDR', () => {
  const env = Buffer.from(capture.scenarios[0].envelope, 'base64');
  assert.throws(() => decodeEnvelope(b64(env.subarray(0, env.length - 3))), /truncated/);
  assert.throws(() => decodeEnvelope(b64(Buffer.concat([env, Buffer.alloc(4)]))), /trailing/);
  // A symbol "ab" padded with a non-zero byte.
  assert.throws(() => decodeScVal(b64(Buffer.from([0, 0, 0, 15, 0, 0, 0, 2, 0x61, 0x62, 0, 1]))), /padding/);
  // A vector nested past the depth limit.
  const deep = Buffer.concat([...Array(70)].map(() => Buffer.from([0, 0, 0, 16, 0, 0, 0, 1, 0, 0, 0, 1])));
  assert.throws(() => decodeScVal(b64(deep)), /deeply/);
  assert.throws(() => decodeEnvelope(b64(Buffer.from([0, 0, 0, 0]))), /v0 envelopes/);
});
