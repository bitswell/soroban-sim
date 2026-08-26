# Component Model design review

Status: **review / proposal — nothing here is applied.** Any ABI-affecting WIT
change needs explicit approval and must not land while PR #16 (visual debugger)
is open. The M0 golden (388-byte SSIM, sha256 `3b678efa…`) and the Playwright
suite are invariants every proposal below preserves.

Reviewed on branch `review/component-model`. Every number in this document was
measured against the real artifacts on 2026-08-24 (node v24.18.0, Apple
Silicon); every ABI claim was checked against the actual generated glue, not
toolchain documentation.

Toolchain: wit-bindgen **0.60.0** (guest bindings), jco **1.30.0** /
wit-component **0.246.2** (transpile), `wasm32-wasip2`, release profile
`opt-level = "z"`, `lto = true`, `codegen-units = 1`, `strip = "symbols"`,
`panic = "abort"`.

## 1. The artifact, precisely

| Artifact | Size | Notes |
|---|---|---|
| `wit/simulator.wit` | — | one `world simulator`, all types inline, 4 exports, **zero authored imports** |
| `soroban_sim_component.wasm` | 3,118,559 B | the component; `jco wit` extracts the world below |
| `soroban-sim-component.core.wasm` | 3,109,323 B | inner core module after transpile |
| `soroban-sim-component.js` | 232,513 B | jco glue: the Canonical ABI implemented in JS |
| fixture contracts | 403 / 626 / 1,151 B | `add_i32` / `caller` / `storage` — embedded via `include_bytes!` |

The extracted world (`pnpm exec jco wit target/wasm32-wasip2/release/soroban_sim_component.wasm`)
matches the authored WIT types and exports exactly, plus **15 WASI imports, all
@0.2.9**: `wasi:io/{poll,error,streams}` (3), `wasi:cli/{stdin,stdout,stderr,
environment,exit,terminal-input,terminal-output,terminal-stdin,terminal-stdout,
terminal-stderr}` (10), `wasi:clocks/monotonic-clock`, `wasi:random/insecure-seed`.
None of these is authored — all 15 are the `wasm32-wasip2` Rust std baseline
(stdio plumbing, `std::process`, `Instant`, `HashMap` `RandomState`).

The core module declares a **20-page (1.25 MiB) initial memory with no
maximum** and exports `memory`, `cabi_realloc`, the four WIT exports, and four
`cabi_post_*` free functions. The glue binds only three of the four:
`cabi_post_simulate` is reused for `simulate-transaction` (identical
`result<outcome, string>` return shape); `cabi_post_simulate-transaction`
exists in the core module but is never called.

## 2. The Canonical ABI as actually generated

This section is grounded in `packages/soroban-sim/src/generated/soroban-sim-component.js`
(line numbers from the current generated file).

### Lowering a `simulate(request)` call (glue L5134–5351)

1. **One struct allocation.** `realloc0(0, 0, 8, 88)` — an 88-byte, 8-aligned
   flat struct for the whole `request` record. `realloc0` is
   `exports1.cabi_realloc` (bound at init, L7557): every allocation is a call
   *into* the guest's dlmalloc. There is no JS-side arena.
2. **One allocation + one memcpy per `list<u8>`.** Each byte list gets its own
   `realloc0(0, 0, 1, len)`, then
   `new Uint8Array(memory0.buffer, ptr, len).set(srcView)` — a single memcpy —
   and its `(ptr, len)` pair written into the struct via `DataView`. Four fixed
   lists cross this way: `host-function-xdr`, `source-account-xdr`,
   `ledger-context.network-id`, `base-prng-seed`. (A plain JS `Array` input
   falls into a slow per-byte validated loop; the TS layer always passes
   `Uint8Array`, so the `.set` fast path is what runs.)
3. **`ledger-entries`:** one outer table `realloc0(0, 0, 4, N * 16)` — 16
   bytes per entry: `(ptr, len)` for `entry-xdr` plus an inline `option<u32>`
   as discriminant byte at `base+8` and payload at `base+12` — then one
   realloc + one memcpy per entry's `entry-xdr` inside the loop.
4. **`known-absent-keys` (`list<list<u8>>`):** outer table
   `realloc0(0, 0, 4, K * 8)` (8 B = ptr+len per key) plus one realloc + memcpy
   per key. The table realloc runs even when `K = 0`.
5. **Scalars/bools** are written directly: `enable-diagnostics` at `ptr0+80`,
   `apply-rpc-adjustments` at `ptr0+81`.
6. The wasm call itself is a single-pointer flat call.

**Cost model** for a request with N present entries and K absent keys:
**7 + N + K `cabi_realloc` calls** into the guest and **4 + N + K memcpys**.
`simulate-transaction` is the same shape with an 80-byte struct;
`simulate-trace` reuses the 88-byte `request` layout.

### Lifting the returned `outcome` (glue L5367–5446)

The guest returns one pointer to a result struct. The glue reads the
`result<_, _>` discriminant byte at `ret+0`, then the `outcome` discriminant at
`ret+4`:

- `complete`: `new Uint8Array(memory0.buffer.slice(ptr, ptr + len))` — the
  SSIM payload is **fully copied** out of linear memory (fresh ArrayBuffer).
- `needs-state`: a loop of `buffer.slice` copies, one fresh `Uint8Array` per
  ledger key.
- `err`: `TextDecoder.decode` over a memory view (decode copies implicitly),
  then the export throws `ComponentError(message)`.

After lifting, `postReturn0(ret)` calls `cabi_post_simulate` so the guest frees
the return-value allocation. **No view into wasm memory ever escapes the
boundary** — callers own plain JS copies, which is what makes the Worker
`postMessage` topology safe.

### Instantiation (`$init`, glue L7498–7631)

The glue is a plain ES module with top-level await: `fetch` +
`WebAssembly.compileStreaming` of the core wasm, plus two tiny base64-inlined
shim modules (wit-component 0.246.2's import-indirection dance — a funcref
table patched after memory exists), for **three core instances** total.
Instantiation therefore happens exactly once per module graph — once per
Worker. Respawning the Worker is the only way to reclaim linear memory or
interrupt a hung synchronous call, exactly as `simulator.ts` documents.

One naming nuance worth knowing: the core module's *import strings* are mostly
`@0.2.0` (the minimum version the adapter linked against) with
`random/insecure-seed@0.2.9`, while the component-level world reports all
imports at `@0.2.9`. Both are satisfied by `@bytecodealliance/preview2-shim`.

## 3. Measured runtime profile

| Measurement | Value |
|---|---|
| Cold dynamic import (compile 3.1 MB core + eval 227 KB glue + shims + `$init`) | **~21–26 ms** |
| — of which raw `WebAssembly.compile` of the core | ~3 ms |
| First-ever `simulate` call (tier-up + lazy init) | **~14 ms** |
| Warm single `simulate` call (12-entry snapshot) | **0.15–0.17 ms** |
| Warm full 13-round rerun loop incl. provider | **0.6–0.7 ms** |
| Linear memory after `$init` | 20 pages / 1.25 MiB |
| Linear memory after first full run — and after 9 further runs | **36 pages / 2.25 MiB, flat** |

Memory never shrinks (wasm has no `memory.shrink`), but for this workload the
high-water mark is reached once and reused; a long-lived Worker is flat at
2.25 MiB.

### WASI is empirically dead weight

With jco's built-in instrumentation enabled (`JCO_DEBUG=1`), a complete cold
start plus a successful `simulate` call fires **exactly one WASI import**:
`wasi:random/insecure-seed`, called once — Rust std seeding `HashMap`'s
`RandomState`. Simulation determinism does not depend on it: the Soroban host
PRNG is seeded exclusively from the `base-prng-seed` request field, and the
component imports no `wasi:random/random` at all. `stderr`/`streams` would
fire only on panic output; the five `terminal-*` interfaces, `stdin`,
`stdout`, `environment`, `exit`, `monotonic-clock`, and `poll` are pure
link-time baggage. The component is functionally pure compute.

Shrinking the import surface to near-zero is possible (build for
`wasm32-unknown-unknown` + `wasm-tools component new` without the WASI
adapter) but means auditing soroban-env-host for std-io/HashMap reliance and
giving up panic messages — real engineering cost for zero user-visible win
while preview2-shim ships in the bundle anyway. **Verdict: keep, and document
(this section is that documentation).**

### The rerun loop re-sends everything, every round — measured

`simulator.ts#runLoop` keeps one growing `ledgerEntries` array plus
`knownAbsentKeys`, and every round `buildRequest` embeds the **entire**
accumulated set in a fresh `Request`. There is no delta or session API in the
WIT; the component is stateless by design.

Measured on `local-add-i32`, cold (empty seed, in-memory provider):

- **13 rounds, 12 requested keys — exactly one key per round**, empirically
  confirming architecture.md's "first implementation discovers one key per
  run" (the Unknown-read sentinel aborts on the first miss; no batching).
- Entry-XDR bytes lowered per round: 0, 44, 144, 172, 196, 224, 256, 320,
  2060, 3800, 4060, 4164, 4668 (small ConfigSetting entries first, then the
  ~1.7 KB ContractCode/instance entries), plus a fixed 168 B of
  host-function/source-account/network-id/seed re-lowered every round.
- **Cumulative lowered: 22,292 B vs 4,836 B for the final round alone — a
  4.6× re-send amplification.** Lifted back out across the whole run: 552 B
  (needs-state key lists + the final 388-byte SSIM — the same 388 bytes the
  web-demo golden hashes).

For scale: the `native-sac-transfer` parity fixture carries 13 entries /
4,492 B of entry XDR (host-function 164 B, envelope 264 B), i.e. ~4.8 KB and
20 realloc round-trips per round — the same shape.

**The honest conclusion: the dominant boundary tax of the stateless design is
recomputation, not memcpy.** Copying even a 1 MB snapshot is single-digit
milliseconds; each needs-state round re-runs the entire host invocation from
scratch. The O(rounds × snapshot) copy curve is real but currently noise
(~22 KB total here). This framing matters for the session-resource decision in
§6: its near-term value is ergonomics and introspection, not throughput.

## 4. WIT design critique

| # | Dimension | Verdict | Rationale |
|---|---|---|---|
| 1 | Types inline in `world` vs named `interface` | **Improve** | Inline types can't be reused by other worlds or versioned independently; a named interface costs nothing and namespaces the bindings. |
| 2 | Fully stateless / no resources | **Keep now, add later** | Statelessness *is* the determinism + Worker story; a session resource is a real M2+ addition (see §6), not a replacement. |
| 3 | `result<outcome, string>` errors | **Improve** | Issue #13 already commits to a malformed / unsupported / internal taxonomy; the flat string erases it. `lib.rs` L31–43's blanket `.map_err(\|e\| e.to_string())` is where the information dies. |
| 4 | `list<u8>` XDR opacity | **Keep bytes, add aliases** | A typed WIT mirror of stellar-xdr would be a huge drift surface and would lose the canonical-bytes property the golden and needs-state key identity depend on. Zero-ABI-cost `type` aliases give the self-documentation for free. |
| 5 | `request`/`transaction-request` duplication; 3 exports | **Improve** | 6 fields duplicated verbatim; worse, `simulate-trace` only accepts `request` — **a transaction envelope cannot be traced today**. A factored `invocation` variant fixes both in one move. |
| 6 | `run-fixture` in the production surface | **Improve (gate)** | Size is a non-argument (fixtures total 2,180 B); the issue is API hygiene — a parameterless test scaffold in every consumer's world. `@unstable(feature = fixture)` removes it from shipped worlds while CI keeps the fixture-enabled build for the M0 golden. |
| 7 | 15-interface WASI surface | **Keep, documented** | See §3: empirically one call, zero load-bearing. Fighting std for a smaller world is cost without win. |
| 8 | Versioning hygiene | **Improve policy** | `@0.1.0` is right today. Batch every ABI break into a single `@0.2.0`; adopt `@since`/`@unstable` gates from then on; pin the extracted world as a CI golden (`jco wit` output) so a toolchain bump can't silently move the WASI version floor. |

## 5. Proposed 0.2.0 surface (syntax-validated)

The full proposal below **parses cleanly under this repo's exact toolchain**
(round-tripped through jco 1.30's WIT parser via `jco types`). Verified
behaviors: the `@unstable(feature = fixture)` export is dropped from generated
bindings unless the feature is enabled, and the interface split moves the jco
exports under a `simulate` namespace object.

```wit
package theahaco:soroban-sim@0.2.0;

interface types {
    /// stellar-xdr LedgerKey, canonical XDR bytes.
    type ledger-key-xdr = list<u8>;
    /// stellar-xdr LedgerEntry, canonical XDR bytes.
    type ledger-entry-xdr = list<u8>;
    /// stellar-xdr HostFunction bytes.
    type host-function-xdr = list<u8>;
    /// stellar-xdr TransactionEnvelope bytes.
    type transaction-envelope-xdr = list<u8>;
    /// SSIM-encoded simulation result (this package's deterministic encoding).
    type ssim-blob = list<u8>;
    /// STRC-encoded semantic trace steps.
    type strc-blob = list<u8>;

    record ledger-context {
        protocol-version: u32,
        sequence-number: u32,
        timestamp: u64,
        network-id: list<u8>,
        base-reserve: u32,
        min-temp-entry-ttl: u32,
        min-persistent-entry-ttl: u32,
        max-entry-ttl: u32,
    }

    record ledger-entry {
        entry-xdr: ledger-entry-xdr,
        live-until-ledger: option<u32>,
    }

    record host-function-invocation {
        host-function-xdr: host-function-xdr,
        source-account-xdr: list<u8>,       // stellar-xdr AccountId
    }

    /// What to run: a pre-split host function, or a full transaction
    /// envelope (the InvokeHostFunction op is extracted guest-side).
    variant invocation {
        host-function(host-function-invocation),
        transaction(transaction-envelope-xdr),
    }

    /// Everything that is context rather than payload.
    record sim-options {
        ledger-context: ledger-context,
        ledger-entries: list<ledger-entry>,
        known-absent-keys: list<ledger-key-xdr>,
        base-prng-seed: list<u8>,
        enable-diagnostics: bool,
        apply-rpc-adjustments: bool,
    }

    /// The issue-#13 taxonomy, in the type system instead of prose.
    variant sim-error {
        malformed-input(string),   // XDR decode failure, wrong-length seed/network-id
        unsupported(string),       // valid data we don't handle (e.g. non-InvokeHostFunction op)
        internal(string),          // bug / infrastructure failure; never expected
    }

    variant outcome {
        complete(ssim-blob),
        needs-state(list<ledger-key-xdr>),
    }

    record trace-complete { ssim: ssim-blob, trace: strc-blob }
    record trace-fallback { ssim: ssim-blob, reason: string }

    variant trace-outcome {
        complete(trace-complete),
        needs-state(list<ledger-key-xdr>),
        trace-unavailable(trace-fallback),
    }
}

interface simulate {
    use types.{invocation, sim-options, outcome, trace-outcome, sim-error, ssim-blob};

    simulate: func(invocation: invocation, options: sim-options) -> result<outcome, sim-error>;
    simulate-trace: func(invocation: invocation, options: sim-options) -> result<trace-outcome, sim-error>;

    @unstable(feature = fixture)
    run-fixture: func() -> result<ssim-blob, sim-error>;
}

world simulator {
    export simulate;
}
```

What this buys, concretely:

- **Two exports instead of three, no duplicated record** — and tracing a
  transaction becomes free (`extract_invoke_host_function` already exists
  guest-side; `simulate_transaction_request` and `simulation_request_from_wit`
  collapse into one mapper over `invocation`). Separate `simulate` /
  `simulate-trace` exports stay because the return types genuinely differ and
  WIT has no return-type polymorphism; merging would force every plain caller
  through the fatter `trace-outcome`.
- **`sim-error` makes retryable-vs-caller-bug machine-distinguishable.** jco
  lifts it as `{ tag: 'malformed-input' | 'unsupported' | 'internal', val }`.
  Guest impact: core grows a small error enum; the classification points are
  the `from_xdr`/`fixed_32` sites (→ `malformed-input`), the
  "not an InvokeHostFunction" path (→ `unsupported`), rest → `internal`.
- **Aliases are pure documentation** — they erase in the Canonical ABI, so
  they could even land on 0.1.x independently of everything else.
- **`run-fixture` gating is proven mechanics on this toolchain**: wit-bindgen
  0.60's `generate!` takes `features: ["fixture"]` (put it behind a cargo
  feature), and jco simply doesn't see the export in a production build. CI
  keeps building with the feature so the M0 golden pipeline is untouched.
  Fallback if gate friction appears: a second `world simulator-dev` that adds
  the export, built in CI only.

Migration impact (verified against generated bindings): the interface split
moves the JS surface from `component.simulate(...)` to
`component.simulate.simulate(...)` — a one-line accessor change (or re-export
shim) in `packages/soroban-sim/src/simulator.ts`'s `Component` type; the Rust
`Guest` trait moves under `exports::theahaco::soroban_sim::simulate`. SSIM
bytes and loop semantics are untouched, so the golden and Playwright stay
green. **All of §5 is one batched break to `@0.2.0` — never serial 0.x
breaks, since jco consumers vendor generated bindings.**

## 6. Session resource: add in M2, alongside — not instead of — stateless

Proposed shape (validated: parses, and jco 1.30 generates
`class SimSession implements Disposable { … [Symbol.dispose]() }` from exactly
this WIT):

```wit
interface session {
    use types.{ledger-entry, ledger-key-xdr, invocation, sim-options,
               outcome, trace-outcome, sim-error};

    resource sim-session {
        constructor(options: sim-options);
        add-entries: func(entries: list<ledger-entry>);
        add-absent: func(keys: list<ledger-key-xdr>);
        /// Re-executes from the accumulated snapshot. needs-state keys are
        /// NOT auto-remembered; the caller answers via add-entries/add-absent.
        run: func(invocation: invocation) -> result<outcome, sim-error>;
        run-trace: func(invocation: invocation) -> result<trace-outcome, sim-error>;
        entry-count: func() -> u32;
        snapshot-bytes: func() -> u64;
    }
}
```

Honest ledger of costs and wins, against the measurements in §3:

- **Wins**: incremental `add-entries` sends only the newly-resolved batch
  (kills the 4.6× re-send curve); ConfigSetting entries load once instead of
  every round; budget/footprint introspection becomes methods instead of more
  encoded blobs. Determinism is unchanged — `run()` still restarts execution
  from the accumulated snapshot, so SSIM stays byte-identical.
- **Costs**: the TS loop must own handle lifetime — jco resources are
  instance-local JS classes; a leaked session is leaked guest snapshot memory
  until Worker teardown (`[Symbol.dispose]`/`using` helps, but it is a new
  obligation the pure-data API doesn't have). Handles do not cross
  `postMessage`, a genuine constraint for the web-demo Worker topology —
  which is precisely why the stateless functions remain the canonical
  contract.
- **Timing**: today the amplification is 22 KB of copies on a sub-millisecond
  loop — noise. Add the resource when RpcStateProvider workloads produce
  snapshots big enough to measure, and ship it `@unstable(feature = sessions)`
  first.

## 7. Sequencing

1. **Now, non-breaking**: XDR type aliases (§4-4); this document serves as the
   WASI/runtime-footprint documentation (§3); record the trace/transaction
   asymmetry as a known gap; add the extracted-world `jco wit` golden to CI.
2. **One batched `@0.2.0` break (needs approval; after PR #16)**: interface
   split + `sim-error` + `invocation`/`sim-options` factoring + `run-fixture`
   gate. One regeneration of wit-bindgen guest, jco bindings, and the
   simulator.ts adapter.
3. **M2, additive, `@unstable`**: `sim-session` resource, once there's a
   measurable boundary baseline from real RPC workloads.

## 8. Documentation drift (ready-to-apply fixes, kept out of this review's diff)

`docs/architecture.md` has drifted from the shipped surface:

- L23: `packages/soroban-sim` is no longer a "placeholder around Jco output" —
  it owns the rerun loop, LimitTracker, InMemory/Rpc providers, and the
  differential harness.
- "Current WIT" (L26–48) lists only `run-fixture` + `simulate`; it omits
  `simulate-transaction`, `simulate-trace`, `transaction-request`,
  `trace-outcome`/`trace-complete`/`trace-fallback`, and the
  `apply-rpc-adjustments` field.
- L37 "(transaction-envelope XDR is deferred past M1)" — stale;
  `simulate-transaction` exists.
- L91's "one key per run" is now quantified: 13 rounds / 12 keys / 22.3 KB
  cumulative lowered for `local-add-i32` — the concrete number that motivates
  batching.
- Nowhere states the runtime footprint (§3) or that the component is stateless
  per call; both belong in a short "runtime footprint" note.
