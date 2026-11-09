// compareAuth: pairing a request's entries with an independent recording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareAuth, decodeAuthEntry, decodeEnvelope } from '../src/xdr.js';
import { capture, scenario } from './fixture.mjs';

const requested = (id) => decodeEnvelope(scenario(id).envelope).tx.operations[0].auth;
const recorded = (id) => scenario(id).preview.recordedAuth.map(decodeAuthEntry);

test('a request that matches the recording', () => {
  for (const id of ['within-cap', 'over-cap']) {
    const cmp = compareAuth(requested(id), recorded(id));
    assert.deepEqual(cmp.entries.map((e) => e.status), ['match'], id);
    assert.deepEqual(cmp.missing, []);
  }
});

test('an entry the transaction does not use is extra', () => {
  const cmp = compareAuth(requested('unused-entry'), recorded('unused-entry'));
  assert.deepEqual(cmp.entries.map((e) => e.status), ['match', 'extra']);
  assert.deepEqual(cmp.missing, []);
});

test('order does not matter, nonces and signatures do not count', () => {
  const [used, extra] = requested('unused-entry');
  const cmp = compareAuth([extra, used], recorded('unused-entry'));
  assert.deepEqual(cmp.entries.map((e) => e.status), ['extra', 'match']);
  const signed = decodeAuthEntry(scenario('within-cap').preview.signedAuth[0]);
  assert.equal(compareAuth([signed], recorded('within-cap')).entries[0].status, 'match');
});

test('same signer, different tree: differs', () => {
  // The 8 XLM request against the 5 XLM recording.
  const cmp = compareAuth(requested('over-cap'), recorded('within-cap'));
  assert.deepEqual(cmp.entries.map((e) => e.status), ['differs']);
  assert.deepEqual(cmp.missing, []);
});

test('a recorded entry nobody supplied is missing', () => {
  const cmp = compareAuth([], recorded('within-cap'));
  assert.deepEqual(cmp.entries, []);
  assert.deepEqual(cmp.missing, [0]);
});

test('the fixture is what the tests assume', () => {
  assert.deepEqual(capture.scenarios.map((s) => s.id), ['within-cap', 'over-cap', 'unused-entry']);
});
