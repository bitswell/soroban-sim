// The preview engine for <soroban-sign-dialog>.
//
// Imported lazily on the first "Preview effects". It reads ledger state from
// RPC (or any state provider), runs the soroban-sim-preview reactor in a
// Worker, and returns a PreviewResult:
//
//   1. getLatestLedger and the first getLedgerEntries batch run in parallel.
//      The reactor build for the network's protocolVersion starts
//      downloading as soon as the header arrives. A protocol with no build
//      gets a fallback (tree only), never a guess.
//   2. record: the authorization tree the host records on its own, effects.
//      A run that reads an unfetched key returns `needs-state` and is
//      repeated once the keys are fetched.
//   3. enforce (with a signer hint): the request's own entries, the account's
//      verifier swapped for an accept-all stub in the reactor's in-memory
//      ledger, so the account's policy gives its verdict before anything is
//      signed.
//   4. account adapters read the rule and spend window it applies.
//
// Usage: dialog.previewProvider = createPreview({ rpcUrl, hints });

import { decodeEnvelope, decodeLedgerEntry, decodeAuthEntry, compareAuth, nativeAssetContract, fromB64, toB64, fromStrkey, strkeyFor, short, NETWORKS } from '../xdr.js';
import { CONFIG_KEYS, isNonceKey, nonceKey } from './ledger-keys.js';
import { perchAdapter } from './perch.js';

/**
 * Reactor builds by host protocol. Keep in step with the `p29`/`p30`
 * features of crates/soroban-sim-preview (the package build checks it).
 */
export const BUILDS = {
  29: { host: 'soroban-env-host 29.0.2', wasm: 'soroban-sim-preview-p29.wasm' },
  30: { host: 'soroban-env-host 30.0.0', wasm: 'soroban-sim-preview-p30.wasm' },
};

const engineInfo = (protocol) => ({ name: 'soroban-sim', host: BUILDS[protocol]?.host ?? null, protocol: protocol ?? null, builds: Object.keys(BUILDS).map(Number) });

const DEFAULT_RPC = {
  [NETWORKS.testnet]: 'https://soroban-testnet.stellar.org',
};

// ---------------------------------------------------------------------------
// Reactor framing (little-endian; the Stellar values inside are XDR).
// ---------------------------------------------------------------------------

const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

class W {
  constructor() { this.parts = []; }
  u8(v) { this.parts.push(Uint8Array.of(v)); return this; }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.parts.push(b); return this; }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.parts.push(b); return this; }
  raw(b) { this.parts.push(b); return this; }
  blob(b) { return this.u32(b.length).raw(b); }
  bytes() { const n = this.parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of this.parts) { o.set(p, i); i += p.length; } return o; }
}

class R {
  constructor(b) { this.b = b; this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); this.o = 0; }
  u8() { return this.b[this.o++]; }
  u32() { const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  blob() { const n = this.u32(); const x = this.b.subarray(this.o, this.o + n); this.o += n; return x; }
  list(f) { const n = this.u32(); return Array.from({ length: n }, () => f()); }
}

const OP_PROVIDE = 1, OP_RESET = 2, OP_RUN = 3;
const ST_COMPLETE = 0, ST_NEEDS_STATE = 1, ST_ERROR = 2;

// ---------------------------------------------------------------------------
// State providers.
// ---------------------------------------------------------------------------

/** Stellar RPC: getLatestLedger + getLedgerEntries. */
export function rpcProvider(url) {
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  };
  return {
    describe: () => url,
    async getLatestLedger() {
      const r = await rpc('getLatestLedger');
      return { sequence: r.sequence, protocolVersion: r.protocolVersion, closeTime: Number(r.closeTime ?? 0), headerXdr: r.headerXdr };
    },
    async getLedgerEntries(keys) {
      const out = [];
      let latest = 0;
      for (let i = 0; i < keys.length; i += 200) {
        const r = await rpc('getLedgerEntries', { keys: keys.slice(i, i + 200) });
        latest = r.latestLedger;
        for (const e of r.entries ?? []) {
          // RPC returns LedgerEntryData; the reactor takes a LedgerEntry.
          const data = fromB64(e.xdr);
          const entry = new Uint8Array(data.length + 8);
          new DataView(entry.buffer).setUint32(0, e.lastModifiedLedgerSeq);
          entry.set(data, 4);
          out.push({ key: e.key, entry: toB64(entry), liveUntil: e.liveUntilLedgerSeq ?? null });
        }
      }
      return { entries: out, latestLedger: latest };
    },
  };
}

/** An in-memory ledger: { ledger: [{ key, entry, liveUntil }], latest } (fixtures, tests). */
export function fixtureProvider({ ledger, latest, latency = 0, name = 'a fixture ledger' }) {
  const map = new Map(ledger.map((e) => [e.key, e]));
  const wait = () => new Promise((r) => setTimeout(r, latency));
  return {
    describe: () => `${name} (${map.size} entries)`,
    async getLatestLedger() { await wait(); return latest; },
    async getLedgerEntries(keys) { await wait(); return { entries: keys.map((k) => map.get(k)).filter(Boolean), latestLedger: latest.sequence }; },
  };
}

/** LedgerHeader.baseReserve; null when the header has a shape this does not know. */
function baseReserveFromHeader(headerXdr) {
  try {
    const b = fromB64(headerXdr);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 4 + 32 + 32 + 8; // ledgerVersion, previousLedgerHash, txSetHash, closeTime
    const nUp = v.getUint32(o); o += 4;
    for (let i = 0; i < nUp; i++) { const n = v.getUint32(o); o += 4 + ((n + 3) & ~3); }
    const sig = () => { o += 4 + 32; const n = v.getUint32(o); o += 4 + ((n + 3) & ~3); };
    const ext = v.getUint32(o); o += 4;
    if (ext === 1) sig();
    else if (ext === 2) { o += 32 + 32 + 4; sig(); }
    else if (ext === 3) { o += 8; sig(); } // protocol 30: SIGNED_MS
    else if (ext === 4) { o += 8 + 32 + 32 + 4; sig(); } // protocol 30: EMPTY_TX_SET_MS
    else if (ext !== 0) return null;
    o += 32 + 32 + 4 + 8 + 8 + 4 + 8 + 4; // results, bucket list, seq, coins, fee pool, inflation, idPool, baseFee
    return v.getUint32(o);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// The reactor, in a Worker (or inline).
// ---------------------------------------------------------------------------

const engines = new Map();
// Each custom `wasm` function gets its own cache slot.
const sources = new WeakMap();
let nextSource = 0;

/** The reactor on the calling thread: for pages and runtimes without a Worker. */
async function loadInline(source) {
  const { createReactor } = await import('./reactor.js');
  const t0 = performance.now();
  const source_ = await source;
  const reactor = await createReactor(source_);
  return {
    init: { ...reactor.info, loadMs: performance.now() - t0, thread: 'main' },
    async call(bytes) { const t = performance.now(); const out = reactor.call(bytes); return { out, ms: performance.now() - t }; },
  };
}

async function loadWorker(url) {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map();
  worker.onmessage = ({ data }) => { const p = pending.get(data.id); pending.delete(data.id); data.ok ? p.resolve(data) : p.reject(new Error(data.error)); };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'the preview worker failed')); pending.clear(); };
  const send = (msg, transfer) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer ?? []); });
  const t0 = performance.now();
  const init = (await send({ type: 'init', url: String(await url) })).value;
  return {
    init: { ...init, loadMs: performance.now() - t0, thread: 'worker' },
    async call(bytes) { const r = await send({ type: 'call', bytes }, [bytes.buffer]); return { out: r.value, ms: r.ms }; },
  };
}

function loadEngine(protocol, opts) {
  if (opts.wasm && !sources.has(opts.wasm)) sources.set(opts.wasm, nextSource++);
  const key = `${protocol}:${opts.inline ? 'inline' : 'worker'}:${opts.wasm ? `custom-${sources.get(opts.wasm)}` : 'default'}`;
  if (!engines.has(key)) {
    const source = opts.wasm ? opts.wasm(protocol) : new URL(`./${BUILDS[protocol].wasm}`, import.meta.url).href;
    const p = (opts.inline || typeof Worker === 'undefined' ? loadInline(source) : loadWorker(source)).then((engine) => {
      // A stale or mislabelled file must not run under the wrong rules.
      if (engine.init.hostProtocol !== protocol) throw new Error(`the protocol ${protocol} build reports protocol ${engine.init.hostProtocol}`);
      return engine;
    });
    p.catch(() => engines.delete(key));
    engines.set(key, p.then((engine) => ({ ...engine, turn: Promise.resolve() })));
  }
  return engines.get(key);
}

// ---------------------------------------------------------------------------
// Preview.
// ---------------------------------------------------------------------------

/**
 * A previewProvider bound to options:
 * { rpcUrl, stateProvider, hints, tokens, wasm, inline }.
 */
export function createPreview(options = {}) {
  return (request) => preview({ ...request, ...options });
}

/**
 * hints: { [accountC]: { verifier: 'C…', key: hex, grantId?, ruleId?, ruleIds? } }.
 * An account with a hint gets the enforcing preview; the rest are recorded
 * only. wasm: (protocol) => URL or wasm bytes, to serve the reactor builds
 * from elsewhere.
 */
export async function preview(req) {
  const t = { start: performance.now() };
  const signal = req.signal;
  const passphrase = req.networkPassphrase;
  const base = { version: 1, engine: engineInfo(null) };
  const fallback = (code, params, notice, extra) => ({ ...base, ...extra, status: 'fallback', code, params, notice });
  if (!req.transaction) return fallback('no-transaction', {}, 'A preview needs the whole transaction. For bare authorization entries the dialog shows the tree only.');
  const decoded = decodeEnvelope(req.transaction);
  const op = decoded.tx.operations[0];
  if (decoded.feeBump) return fallback('fee-bump', {}, 'Preview the inner transaction of a fee bump.');
  if (op?.type !== 'invoke') return fallback('not-invoke', { operation: op?.type ?? 'unknown' }, `This ${op?.type ?? 'unknown'} operation authorizes nothing; there is nothing to preview.`);
  const rpcUrl = req.rpcUrl ?? DEFAULT_RPC[passphrase];
  const state = req.stateProvider ?? (rpcUrl ? rpcProvider(rpcUrl) : null);
  if (!state) return fallback('no-rpc', {}, 'No RPC is configured for this network, so ledger state cannot be read.');

  // 1. State: every key the request already names, fetched in one batch
  //    alongside the ledger header: the network config, the transaction's
  //    footprint, the nonce keys of its signed entries, and what the account
  //    adapters know they will read.
  const known = new Map(); // key -> entry, or null when absent
  const pushed = new Set();
  let fetched = 0, rounds = 0, rpcCalls = 0;
  const roundKeys = [];
  const fetchKeys = async (keys) => {
    const want = [...new Set(keys)].filter((k) => !known.has(k));
    if (!want.length) return;
    rpcCalls++;
    fetched += want.length;
    const res = await state.getLedgerEntries(want);
    for (const e of res.entries) known.set(e.key, e);
    for (const k of want) if (!known.has(k)) known.set(k, null);
  };
  const tx = decoded.tx;
  const footprint = tx.soroban ? [...tx.soroban.readOnly, ...tx.soroban.readWrite].map((k) => k.xdr) : [];
  const nonces = op.auth.filter((e) => e.credentials.address).map((e) => nonceKey(e.credentials.address, e.credentials.nonce));
  const adapters = Object.entries(req.hints ?? {}).map(([account, hint]) => perchAdapter(account, hint));
  const latestPending = state.getLatestLedger();
  // The reactor build for the network's protocol downloads while the rest of
  // the state batch is in flight.
  const enginePending = latestPending.then((l) => (BUILDS[l.protocolVersion] ? loadEngine(l.protocolVersion, req) : null));
  enginePending.catch(() => {});
  const [latest] = await Promise.all([
    latestPending,
    fetchKeys([...CONFIG_KEYS, ...footprint, ...nonces, ...adapters.flatMap((a) => a.prefetch())]),
  ]);
  rpcCalls++;
  signal?.throwIfAborted();
  t.ledger = performance.now();

  // 2. The protocol gate.
  const protocol = latest.protocolVersion;
  const ledger = { sequence: latest.sequence + 1, protocol };
  if (!BUILDS[protocol]) {
    const builds = Object.keys(BUILDS).join(' and ');
    return fallback('protocol', { protocol, builds: Object.keys(BUILDS).map(Number) },
      `The network is on protocol ${protocol}, and this preview engine has builds for protocols ${builds}. Effects are not shown, because a simulation under other rules can be wrong.`,
      { ledger });
  }
  base.engine = engineInfo(protocol);
  const engine = await enginePending;
  signal?.throwIfAborted();
  t.engine = performance.now();

  // One preview at a time per engine, each on a reactor store holding only
  // the entries it pushes.
  const previous = engine.turn;
  let release;
  engine.turn = new Promise((r) => { release = r; });
  try {
    await previous;
    signal?.throwIfAborted();
    const { out } = await engine.call(new W().u8(OP_RESET).bytes());
    if (out[0] !== ST_COMPLETE) throw new Error('the engine could not reset its ledger');

    // Hand the reactor everything known that it has not seen yet.
    const push = async () => {
      const fresh = [...known.keys()].filter((k) => !pushed.has(k));
      if (!fresh.length) return;
      const present = fresh.filter((k) => known.get(k));
      const absent = fresh.filter((k) => !known.get(k));
      const w = new W().u8(OP_PROVIDE).u32(present.length);
      for (const k of present) { const e = known.get(k); w.blob(fromB64(e.entry)).u32(e.liveUntil == null ? 0 : e.liveUntil + 1); }
      w.u32(absent.length);
      for (const k of absent) w.blob(fromB64(k));
      for (const k of fresh) pushed.add(k);
      const { out } = await engine.call(w.bytes());
      if (out[0] !== ST_COMPLETE) throw new Error('the engine refused the ledger entries');
    };
    const provide = async (keys) => { await fetchKeys(keys); await push(); };
    const entries = { get: (k) => known.get(k) ?? undefined };
    await push();

    // The base reserve has been 0.5 XLM on every network since protocol 10.
    const baseReserve = (latest.headerXdr && baseReserveFromHeader(latest.headerXdr)) || 5_000_000;
    const networkId = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passphrase)));
    const envelope = fromB64(req.transaction);
    const header = () => new W().u8(OP_RUN).u32(protocol).u32(ledger.sequence).u64(latest.closeTime + 5).raw(networkId)
      .u32(baseReserve).blob(envelope);
    const run = async (build, recording) => {
      let ms = 0;
      for (let i = 0; i < 25; i++) {
        signal?.throwIfAborted();
        const r = await engine.call(build());
        ms += r.ms;
        const reply = new R(r.out);
        const status = reply.u8();
        if (status === ST_ERROR) throw new Error(new TextDecoder().decode(reply.blob()));
        if (status === ST_NEEDS_STATE) {
          rounds++;
          const keys = reply.list(() => toB64(reply.blob()));
          roundKeys.push(keys);
          // A recording draws fresh nonces; their keys are absent without asking.
          for (const k of keys) if (recording && isNonceKey(fromB64(k))) known.set(k, null);
          await provide(keys);
          continue;
        }
        return { ...parseRun(reply), ms };
      }
      throw new Error('ledger state did not converge after 25 rounds');
    };
    t.prefetch = performance.now();

    // 3. Recording.
    const record = await run(() => header().u8(0).bytes(), true);
    t.record = performance.now();

    // 4. Enforcing, for hinted accounts.
    let enforce = null;
    const used = adapters.filter((a) => op.auth.some((e) => e.credentials.address?.str === a.account));
    if (used.length) {
      for (const a of used) await a.load(provide, entries);
      const build = () => {
        const w = header().u8(1);
        const stubs = [...new Set(used.flatMap((a) => a.verifiers))];
        w.u32(stubs.length);
        for (const v of stubs) w.raw(fromStrkey(v));
        w.u32(used.length);
        for (const a of used) {
          const lists = a.ruleIdLists(op);
          w.raw(fromStrkey(a.account)).u32(lists.length);
          for (const ids of lists) { w.u32(ids.length); for (const id of ids) w.u32(id); }
          w.u32(a.keys.length);
          for (const k of a.keys) w.raw(fromStrkey(k.verifier)).blob(fromHex(k.key));
        }
        return w.bytes();
      };
      enforce = await run(build);
    }
    t.enforce = performance.now();

    // 5. Shape the result.
    const nativeSac = await nativeAssetContract(passphrase);
    const tokens = { [nativeSac]: { code: 'XLM', decimals: 7 }, ...(req.tokens ?? {}) };
    // Budgets and verdicts count only the entries the transaction consumes:
    // those the independent recording also produced. A failed recording
    // produces no tree, so which entries are used is unknown: count them all.
    const cmp = record.ok ? compareAuth(op.auth, record.auth.map(decodeAuthEntry)) : null;
    const consumed = cmp ? { ...op, auth: op.auth.filter((_, i) => cmp.entries[i].status === 'match') } : op;
    const verdicts = [];
    const budgets = [];
    for (const a of used) {
      verdicts.push(a.verdict(consumed, enforce, record, ledger.sequence));
      budgets.push(...a.budgets(consumed, ledger.sequence, tokens));
    }
    // The enforcing run decides when an account refuses (nothing moves) or
    // when it succeeds. When it fails only on other parties' signatures, the
    // recording shows the effects.
    const awaitingOthers = verdicts.some((v) => v.reasonCode === 'unsigned-others') && !verdicts.some((v) => v.allowed === false);
    const effects = enforce && !awaitingOthers ? enforce : record;
    const unhinted = !used.length && op.auth.some((e) => e.credentials.address?.kind === 'contract');
    t.end = performance.now();
    return {
      ...base,
      status: 'ok',
      code: unhinted ? 'no-hint' : undefined,
      notice: unhinted ? 'No signer hint was given, so the account’s own policy was not evaluated; effects assume every authorization passes.' : undefined,
      ledger,
      stateSource: state.describe?.() ?? 'RPC',
      recordedAuth: record.ok ? record.auth : null,
      outcome: { ok: effects.ok, error: effects.ok ? null : effects.error, codes: effects.codes },
      verdicts,
      budgets,
      balances: effects.ok ? balanceChanges(effects.diffs, tokens) : [],
      events: effects.ok ? effects.events : [],
      resources: { instructions: effects.instructions },
      timings: {
        ledgerMs: t.ledger - t.start, engineLoadMs: t.engine - t.ledger, prefetchMs: t.prefetch - t.engine,
        recordMs: t.record - t.prefetch, enforceMs: t.enforce - t.record, totalMs: t.end - t.start,
        reactorRecordMs: record.ms, reactorEnforceMs: enforce?.ms ?? 0, needsStateRounds: rounds, keysFetched: fetched, stateCalls: rpcCalls, roundKeys,
        engine: engine.init,
      },
    };
  } finally {
    release();
  }
}

function parseRun(r) {
  const ok = r.u8() === 1;
  const value = r.blob();
  const codes = r.list(() => { const id = r.blob(); return { contract: id.length ? strkeyFor('contract', id) : null, code: r.u32() }; });
  const auth = r.list(() => toB64(r.blob()));
  const events = r.list(() => toB64(r.blob()));
  const diffs = r.list(() => { const b = r.blob(), a = r.blob(); return { before: b.length ? toB64(b) : null, after: a.length ? toB64(a) : null }; });
  const instructions = r.u32();
  r.u32();
  r.blob();
  const tail = new TextDecoder().decode(r.blob());
  return { ok, value: ok ? toB64(value) : null, error: ok ? null : new TextDecoder().decode(value) + tail, codes, auth, events, diffs, instructions };
}

// ---------------------------------------------------------------------------
// Balance changes from ledger diffs: classic balances and token balances
// stored as `Balance(holder)` contract data (the Stellar Asset Contract and
// SEP-41 tokens built on the SDK's token template).
// ---------------------------------------------------------------------------

function balanceOf(entryB64) {
  if (!entryB64) return null;
  const e = decodeLedgerEntry(entryB64);
  if (e.type === 'account') return { holder: e.account, asset: 'native', amount: e.balance };
  if (e.type === 'trustline' && e.asset.code) return { holder: e.account, asset: `${e.asset.code}:${e.asset.issuer}`, amount: e.balance, code: e.asset.code };
  if (e.type === 'contract-data' && e.key.t === 'vec' && e.key.v.length === 2 && e.key.v[0].v === 'Balance' && e.key.v[1].t === 'address') {
    const v = e.val.t === 'map' ? e.val.v.find((x) => x.k.v === 'amount')?.v : e.val;
    if (v && /128/.test(v.t)) return { holder: e.key.v[1].str, asset: e.contract.str, amount: v.v };
  }
  return null;
}

export function balanceChanges(diffs, tokens) {
  const out = [];
  for (const d of diffs ?? []) {
    const b = balanceOf(d.before), a = balanceOf(d.after);
    const x = a ?? b;
    if (!x) continue;
    const before = b?.amount ?? 0n, after = a?.amount ?? 0n;
    if (before === after) continue;
    const asset = x.asset === 'native' ? { code: 'XLM', decimals: 7 } : tokens[x.asset] ?? { code: x.code ?? short(x.asset), decimals: x.code ? 7 : 0, contract: x.asset };
    out.push({ address: x.holder, asset, before: before.toString(), after: after.toString() });
  }
  return out;
}
