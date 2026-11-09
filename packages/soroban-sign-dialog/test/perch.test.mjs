// The Perch adapter against the captured ledger, without a reactor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perchAdapter } from '../src/preview/perch.js';
import { decodeEnvelope } from '../src/xdr.js';
import { capture, scenario } from './fixture.mjs';

const A = capture.addresses;
const known = new Map(capture.ledger.map((e) => [e.key, e]));
const entries = { get: (k) => known.get(k) };

test('ruleIds select one rule per call within each entry, as the enforcing payload does', async () => {
  const op = decodeEnvelope(scenario('unused-entry').envelope).tx.operations[0];
  const perch = perchAdapter(A.account, { verifier: A.verifier, key: A.appKey, grantId: 1, ruleIds: [A.spendRuleId] });
  await perch.load(async () => {}, entries);
  const mine = op.auth.filter((e) => e.credentials.address?.str === A.account);
  assert.equal(mine.length, 2, 'two entries for the hinted account');
  assert.deepEqual(perch.ruleIdLists(op), [[A.spendRuleId], [A.spendRuleId]]);
  const budgets = perch.budgets(op, capture.network.sequence, {});
  assert.deepEqual(budgets.map((b) => b.rule.id), [A.spendRuleId, A.spendRuleId]);
  // Only the second entry consumed: it is still budgeted under its own list's first rule.
  const second = { ...op, auth: op.auth.filter((e) => e === mine[1]) };
  assert.deepEqual(perch.budgets(second, capture.network.sequence, {}).map((b) => b.rule.id), [A.spendRuleId]);
});
