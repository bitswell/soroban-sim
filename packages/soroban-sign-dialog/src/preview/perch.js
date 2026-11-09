// Perch account adapter for the preview engine.
//
// What it does with a wallet's hint ({ verifier, key, grantId?, ruleId?,
// ruleIds? }):
//
// - Verdict. The engine's enforcing run fills each of the account's entries
//   with the `AuthPayload` Perch reads ({ context_rule_ids, signers:
//   { External(verifier, key) => 64 zero bytes } }) and swaps the verifier
//   contract for an accept-all stub, in the reactor's in-memory ledger only.
//   Perch then checks that the key belongs to the selected rule, calls the
//   stub, and runs its own rule evaluation and spend window. "Accepted" means
//   accepted assuming a valid signature from that key; nothing is signed and
//   nothing touches the network. This works for any account that verifies an
//   External signer through a verifier contract's `verify`.
// - Budget. It reads the grant's rules and spend window from the account's
//   storage in the layout of the Perch release pinned by the fixture
//   (stellar-registry__perch f0275f4): grants as `Scopes(id)`, admin rules in
//   `RuleSet`, spends in `SpendRecords(rule)`. Newer Perch releases keep rules
//   as OpenZeppelin context rules and the window in the spending-limit
//   policy's storage; on those the keys read here are absent, so the verdict
//   still shows but no budget does. Pass `ruleIds` in the hint there.
import { decodeLedgerEntry, fromStrkey } from '../xdr.js';
import { contractDataKey, instanceKey, xSym, xU32, xVec } from './ledger-keys.js';

const PERCH_ERRORS = {
  1: 'a reserved function',
  2: 'the account is frozen for recovery',
  3: 'a stale grant',
  4: 'a grant escalating into recovery',
  5: 'its rules (rule evaluation refused)',
};

export function perchAdapter(account, hint) {
  const id = fromStrkey(account);
  fromStrkey(hint.verifier);
  if (!/^([0-9a-f]{2})+$/i.test(hint.key ?? '')) throw new Error(`hint for ${account}: key must be hex`);
  const keys = [{ verifier: hint.verifier, key: hint.key.toLowerCase() }];
  let rules = [];
  const spends = new Map();
  const view = (entries, k) => { const e = entries.get(k); return e ? decodeLedgerEntry(e.entry) : null; };
  const field = (m, name) => (m?.t === 'map' ? m.v.find((x) => x.k.v === name)?.v : undefined);
  const scopeKey = (g) => contractDataKey(id, xVec(xSym('Scopes'), xU32(g)));
  const spendKey = (r) => contractDataKey(id, xVec(xSym('SpendRecords'), xU32(r)));
  return {
    account, keys, verifiers: [hint.verifier],

    /** Keys worth fetching in the first state batch. */
    prefetch: () => [instanceKey(id), contractDataKey(id, xSym('RuleSet')),
      ...(hint.grantId != null ? [scopeKey(hint.grantId), contractDataKey(id, xVec(xSym('ScopeTags'), xU32(hint.grantId)))] : []),
      ...(hint.ruleId != null ? [spendKey(hint.ruleId)] : [])],

    /** Read the account's rules and spend windows; `provide` fetches keys. */
    async load(provide, entries) {
      let grantIds = hint.grantId != null ? [hint.grantId] : null;
      if (!grantIds) {
        const inst = view(entries, instanceKey(id));
        const count = field({ t: 'map', v: inst?.val?.storage ?? [] }, 'ScopeCount')?.v ?? 0;
        const indexKey = (i) => contractDataKey(id, xVec(xSym('ScopeIndex'), xU32(i)));
        await provide(Array.from({ length: count }, (_, i) => indexKey(i)));
        grantIds = Array.from({ length: count }, (_, i) => view(entries, indexKey(i))?.val?.v).filter((x) => x != null);
      }
      await provide(grantIds.map(scopeKey));
      const raw = [];
      for (const g of grantIds) {
        for (const r of field(view(entries, scopeKey(g))?.val, 'rules')?.v ?? []) raw.push({ grant: g, raw: r });
      }
      for (const r of view(entries, contractDataKey(id, xSym('RuleSet')))?.val?.v ?? []) raw.push({ grant: null, raw: r });
      rules = raw.map(({ grant, raw: r }) => {
        const rule = field(r, 'rule');
        const fns = field(rule, 'functions')?.v ?? [];
        const signers = (field(rule, 'signers')?.v ?? []).map((s) => s.v);
        const cap = (field(rule, 'cap')?.v ?? [])[0];
        return {
          id: field(r, 'id')?.v, name: field(r, 'name')?.v, grant,
          contract: field(rule, 'contract')?.str,
          only: fns[0]?.v === 'Only' ? (fns[1]?.v ?? []).map((f) => f.v) : null,
          except: fns[0]?.v === 'AnyExcept' ? (fns[1]?.v ?? []).map((f) => f.v) : [],
          signers: signers.map((s) => ({ verifier: s[1]?.str, key: s[2]?.v ? Array.from(s[2].v, (b) => b.toString(16).padStart(2, '0')).join('') : null })),
          cap: cap ? { amountArg: field(cap, 'amount_arg')?.v, limit: field(cap, 'limit')?.v, period: field(cap, 'period')?.v } : null,
        };
      });
      const capped = rules.filter((r) => r.cap);
      await provide(capped.map((r) => spendKey(r.id)));
      for (const r of capped) {
        const rec = view(entries, spendKey(r.id));
        spends.set(r.id, (field(rec?.val, 'history')?.v ?? []).map((h) => ({ amount: field(h, 'amount')?.v ?? 0n, ledger: field(h, 'ledger')?.v ?? 0 })));
      }
    },

    /** The contract calls in each of the account's entries, in tree order. */
    entryContexts(op) {
      return op.auth.filter((e) => e.credentials.address?.str === account).map((e) => {
        const out = [];
        const walk = (inv) => { if (inv.fn.kind === 'call') out.push(inv.fn); inv.subs.forEach(walk); };
        walk(e.root);
        return out;
      });
    },

    ruleFor(fn, index = 0) {
      if (hint.ruleIds) return rules.find((r) => r.id === hint.ruleIds[index]) ?? { id: hint.ruleIds[index] };
      return rules.find((r) => r.contract === fn.contract.str && (r.only ? r.only.includes(fn.fn) : !r.except.includes(fn.fn))
        && r.signers.some((s) => s.verifier === hint.verifier && s.key === keys[0].key));
    },

    /** One rule-id list per entry: what each entry's AuthPayload selects. */
    ruleIdLists(op) {
      return this.entryContexts(op).map((fns) => fns.map((fn, i) => this.ruleFor(fn, i)?.id ?? 0));
    },

    /**
     * op: the transaction with only the entries it consumes. A refusal is the
     * account's only when its own contract raised the error; otherwise the
     * verdict is unknown (`allowed: null`).
     */
    verdict(op, enforce, record, sequence) {
      const fns = this.entryContexts(op).flat();
      const rule = fns.length ? this.ruleFor(fns[0]) : null;
      const r = rule?.id != null ? { id: rule.id, name: rule.name, grant: rule.grant } : undefined;
      const v = { address: account, kind: 'perch', rule: r };
      if (enforce?.ok) {
        const params = { rule: rule?.name ?? null, grant: rule?.grant ?? null };
        const under = params.rule ? ` under ${params.grant != null ? `grant ${params.grant}, ` : ''}rule ‘${params.rule}’` : '';
        return { ...v, allowed: true, reasonCode: 'accepted', params, reason: `Accepted${under}, assuming a valid signature from this key.` };
      }
      const code = enforce?.codes?.find((c) => c.contract === account)?.code;
      if (code == null) {
        if (record?.ok && op.auth.some((e) => e.credentials.address && e.credentials.address.str !== account && e.credentials.signature.t === 'void')) {
          return { ...v, allowed: null, reasonCode: 'unsigned-others', params: {}, reason: 'Other parties have not signed yet, so this account’s verdict is unknown.' };
        }
        const error = enforce?.error ?? 'unknown error';
        return { ...v, allowed: null, reasonCode: 'failed', params: { error }, reason: `The enforcing simulation failed: ${error}.` };
      }
      const over = this.budgets(op, sequence, {}).some((b) => BigInt(b.amount) > BigInt(b.limit) - BigInt(b.spentInWindow));
      const params = { code, cause: PERCH_ERRORS[code] ?? null };
      const why = `The account refuses it${params.cause ? ` because of ${params.cause}` : ''} (contract error ${code}).`;
      return { ...v, allowed: false, code, reasonCode: over ? 'refused-over-cap' : 'refused', params,
        reason: over ? `${why} The request is more than the cap has left in this window.` : why };
    },

    budgets(op, sequence, tokens) {
      const out = [];
      for (const [fn, rule] of this.entryContexts(op).flatMap((fns) => fns.map((fn, i) => [fn, this.ruleFor(fn, i)]))) {
        if (!rule?.cap) continue;
        const cutoff = Math.max(0, sequence - rule.cap.period);
        const live = (spends.get(rule.id) ?? []).filter((s) => s.ledger > cutoff);
        const spent = live.reduce((a, s) => a + s.amount, 0n);
        const amount = fn.args[rule.cap.amountArg]?.v ?? 0n;
        out.push({
          address: account, rule: { id: rule.id, name: rule.name, grant: rule.grant }, token: tokens[rule.contract] ?? { code: 'units', decimals: 0, contract: rule.contract },
          limit: rule.cap.limit.toString(), periodLedgers: rule.cap.period, spentInWindow: spent.toString(), amount: amount.toString(),
          ledger: sequence, nextReleaseLedger: live.length ? live[0].ledger + rule.cap.period : null,
        });
      }
      return out;
    },
  };
}
