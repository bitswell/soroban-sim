# Epic: Missing-state Soroban simulation loop and browser state adapter

## Summary

Build the next layer after Milestone 0: turn the fixed in-memory fixture simulator into a reusable Soroban simulation engine that can discover missing ledger state, ask JavaScript to fetch/cache it, rerun deterministically, and expose a browser Worker API ready for real transaction simulation.

Milestone 0 proved the core architecture:

- real Soroban contract bytes stay `wasm32v1-none` core Wasm;
- `soroban-simulation` / `soroban-env-host` execute through Wasmi;
- simulator builds as `wasm32-wasip2` component;
- Jco output runs in a browser Worker;
- native / Wasmtime / browser Worker fixture outputs match.

This epic moves from proof to usable simulator.

## Scope

Primary scope: Milestone 1 and Milestone 2 foundation.

- M1: three-state in-memory snapshot + `needs-state` rerun protocol.
- M2 foundation: TypeScript Worker API, RPC state provider, IndexedDB cache shape.
- M3 parity / Perch integration is intentionally only planned here, not implemented.

## Open decisions

These must be answered or refined while executing the epic:

1. Public API input: full transaction envelope XDR only, host-function XDR only, or both?
2. Public output: raw binary for now, typed TypeScript object now, or both?
3. Network config input: config ledger entries, custom WIT record, or custom binary encoding?
4. Cache context: transaction hash, transaction position, or both?
5. Browser support target: Chromium only for now, or include Firefox/Safari early?
6. Commit generated Jco output or keep CI-generated only?
7. Rust crates: internal only for now, or published eventually?
8. Upstream posture: local adapter first, or prepare upstream patch in parallel?

Default assumption for task breakdown below: keep M1 internal interfaces flexible, expose stable-ish TypeScript API only after missing-state correctness works.

## Goals

- Preserve actual Soroban host execution. No TypeScript simulation model.
- Preserve deterministic inputs: ledger sequence, timestamp, protocol version, network ID/config, PRNG seed.
- Preserve TTLs. Never use synthetic `u32::MAX` for transaction simulation.
- Treat `None` from `SnapshotSource::get` as known absence, not cache miss.
- Represent unknown state explicitly and return missing ledger-key XDR to JavaScript.
- Rerun from the beginning after each fetch to preserve deterministic behavior.
- Keep component free of network and persistent filesystem access.
- Run CPU-heavy simulation in a Worker with termination support.
- Keep signing and secret-key handling out of this package.

## Non-goals

- Transaction submission.
- Wallet key storage.
- Signing inside simulator.
- Running WASI apps as Soroban contracts.
- Turning Soroban contracts into components.
- Replacing RPC simulation as authority before parity testing.
- Polished Perch UI.

## Work breakdown

### 1. Refine core request/response model

Tasks:

- Replace M0 fixture-only result encoding with explicit internal result type.
- Keep contract invocation failure as completed simulation result, not infrastructure error.
- Reserve WIT `result::err` for malformed input, unsupported protocol data, and internal infrastructure failure.
- Add explicit request fields for:
  - host function or transaction XDR;
  - source account;
  - ledger context;
  - network config or config source;
  - base PRNG seed;
  - diagnostics flag;
  - supplied state entries.
- Decide whether M1 exports `simulate-host-function`, `simulate-transaction`, or both.

Acceptance:

- Existing M0 fixture still passes natively, in Wasmtime, and browser Worker.
- Result structure can encode success, contract failure, and missing-state outcome distinctly.
- No public API promises typed final RPC parity fields until tests exist.

### 2. Implement three-state snapshot source

Tasks:

- Add `CachedEntry` enum:
  - `Present { entry, live_until_ledger }`
  - `Absent`
  - `Unknown`
- Update in-memory snapshot to key by `LedgerKey` and preserve TTL.
- Ensure known absence returns `Ok(None)` from `SnapshotSource::get`.
- Ensure unknown records ledger-key XDR in side-channel and aborts recognizably.
- Avoid string matching for missing-state detection.
- Add unit tests for each state.

Acceptance:

- Present entries are returned with actual TTL.
- Known absent entries return `None` and do not request fetching.
- Unknown entries return `needs-state` with ledger-key XDR.
- Same unknown key does not produce noisy duplicates in a single run.

### 3. Missing-state rerun protocol

Tasks:

- Add simulator outcome:
  - `Complete(encoded-result)`
  - `NeedsState(Vec<ledger_key_xdr>)`
- Wire unknown snapshot lookup into `NeedsState`.
- Initially allow discovering one key per run; keep WIT list output for future batching.
- Add deterministic rerun tests:
  1. run with incomplete snapshot;
  2. receive missing key;
  3. insert present or absent response;
  4. rerun from beginning;
  5. repeat until complete.
- Add max-iteration guard in host-side test helper.

Acceptance:

- Deliberately incomplete execution returns expected key XDR.
- Adding returned entry lets execution progress.
- Known absence does not infinite-loop.
- Final result equals complete-snapshot execution.

### 4. Contract code, contract data, TTL, nested calls tests

Tasks:

- Add fixtures/tests for:
  - contract code lookup;
  - contract instance lookup;
  - persistent contract data;
  - temporary contract data;
  - TTL expired temporary data;
  - TTL expired persistent data / restore behavior decision;
  - nested contract calls;
  - execution failure after all state is resolved.
- Keep fixtures binary/XDR and deterministic.
- Add golden outputs where stable.

Acceptance:

- Missing-state tests cover all M1 acceptance cases.
- TTL behavior is explicit and documented.
- Execution failures after state resolution return completed simulation failure, not `needs-state`.

### 5. Network configuration input

Tasks:

- Decide network config path:
  - load from config-setting ledger entries; or
  - custom WIT/config record; or
  - custom binary format.
- Remove M0 fixed `fixture_network_config()` from non-fixture simulation path.
- Make ledger protocol/version compatibility errors explicit.
- Add tests for malformed/missing network config.

Acceptance:

- Non-fixture simulation cannot accidentally use M0 test fee/cost config.
- Network config is explicit deterministic input.
- M0 fixture can still use fixture config behind clearly named test helper.

### 6. Component WIT revision

Tasks:

- Revise `wit/simulator.wit` for three-state supplied state.
- Prefer XDR bytes for Stellar data structures.
- Add explicit absent entries; do not overload missing ledger entries as absent.
- Keep `needs-state(list<list<u8>>)` return.
- Document WIT semantics in `docs/architecture.md`.

Possible shape:

```wit
variant supplied-state {
    present(record { key-xdr: list<u8>, entry-xdr: list<u8>, live-until-ledger: option<u32> }),
    absent(list<u8>),
}

variant outcome {
    complete(list<u8>),
    needs-state(list<list<u8>>),
}
```

Acceptance:

- Component builds for `wasm32-wasip2`.
- Wasmtime fixture still runs.
- Jco transpilation succeeds.
- Browser Worker test passes.

### 7. TypeScript Worker API skeleton

Tasks:

- Add `SorobanSimulator.create(...)` skeleton in `packages/soroban-sim`.
- Move M0 demo-only Worker protocol into package-owned Worker implementation.
- Keep simulation off main thread.
- Support Worker termination.
- Add progress hooks:
  - rerun count;
  - requested key count;
  - last missing key batch.
- Add input shape for state provider abstraction.

Suggested API:

```ts
const simulator = await SorobanSimulator.create({
  networkPassphrase,
  rpcUrl,
  cache,
});

const result = await simulator.simulate(transactionXdr, {
  ledger: exactLedgerContext,
  signal,
  onProgress,
});
```

Acceptance:

- Browser demo uses package API, not local demo-only Worker logic.
- Simulation can be cancelled by terminating Worker.
- No secret keys or signing APIs exist.

### 8. State provider abstraction

Tasks:

- Define TypeScript `StateProvider` interface.
- Implement in-memory test provider.
- Implement RPC provider using Stellar JavaScript SDK after API shape is stable.
- RPC provider must return present/absent/unknown distinctly where possible.
- Preserve TTL from RPC responses.
- Do not call network from component.

Acceptance:

- Unit/integration tests can resolve missing keys without browser IndexedDB.
- RPC provider is swappable.
- Known absence is persisted and rerun-safe.

### 9. IndexedDB cache

Tasks:

- Define cache key identity:
  - network passphrase or network ID;
  - ledger sequence;
  - optional transaction hash/position;
  - protocol version when required;
  - ledger-key XDR hash.
- Store `Present`, `Absent`, and metadata.
- Preserve TTL.
- Add cache versioning.
- Add size limits and eviction policy placeholder.

Acceptance:

- Cached present entries satisfy rerun without RPC.
- Cached absent entries do not trigger fetch loop.
- Cache identity prevents cross-network/cross-ledger contamination.

### 10. Limits and safety

Tasks:

- Add default limits:
  - max reruns;
  - max missing keys total;
  - max ledger entries supplied;
  - max bytes per entry;
  - max total input bytes;
  - Worker timeout.
- Add wasm/contract code size limit before execution where practical.
- Document untrusted input assumptions.
- Ensure budget/accounting still comes from Soroban host.

Acceptance:

- Maliciously large inputs fail before Worker freeze where possible.
- Infinite missing-state loops stop with clear error.
- Worker termination path covered by test.

### 11. Differential testing plan

Tasks:

- Add doc/test harness placeholder for comparing local simulation against Stellar RPC simulation.
- Define comparison fields:
  - invocation result;
  - authorization entries;
  - contract events;
  - diagnostic events where stable;
  - footprint;
  - resource estimates;
  - fees;
  - modified ledger entries;
  - failures.
- Do not gate M1 on full parity.

Acceptance:

- M3 parity work has explicit checklist and fixture format.
- No claim of RPC-equivalent authority before differential tests pass.

### 12. Upstream evidence and patch prep

Tasks:

- Keep `docs/upstream.md` updated with exact blockers.
- If unknown-state requires awkward sentinel errors, document evidence.
- Draft upstream proposal for injectable transaction snapshot storage/resolution backends.
- Keep local adapter narrow until M1 proof exists.

Acceptance:

- Upstream notes contain exact crate, target, error, and minimal proposed fix.
- No large fork started without explicit approval.

## Milestone acceptance criteria

### M1 complete when

- Incomplete snapshot returns expected missing ledger-key XDR.
- Adding returned present entries allows execution to progress.
- Adding known-absent entries does not loop.
- Final complete result matches complete-snapshot execution.
- Tests cover contract code, contract instance/data, TTL, nested calls, and failure-after-resolution.
- Native and component tests pass.

### M2 foundation complete when

- Package-owned Worker API runs the component.
- State provider abstraction resolves missing keys.
- IndexedDB schema can persist present/absent entries with TTL.
- Exact ledger context is pinned.
- Cancellation and iteration limits work.
- Browser test proves rerun loop, not just fixed fixture.

## Dependencies

- `soroban-simulation 28.0.2`
- `soroban-env-host 28.0.2`
- Wasmtime CLI for component proof
- Jco for browser transpilation
- Stellar JavaScript SDK for RPC provider once M2 starts

## Risks

- `SnapshotSource::get` has no native unknown state; local sentinel/side-channel may be ugly.
- WASI imports still include CLI/io/clock/random shims from Rust `std`/deps.
- RPC may not safely prove absence at exact ledger in all cases.
- Network config has no obvious XDR wrapper type.
- Component size and startup cost may grow fast after adding transaction decoding and state handling.

## Tracking checklist

- [ ] Core request/result model refactored.
- [ ] Three-state snapshot implemented.
- [ ] `needs-state` outcome wired through Rust and WIT.
- [ ] Missing-state rerun tests added.
- [ ] TTL behavior tests added.
- [ ] Nested call fixture added.
- [ ] Network config input decided and implemented.
- [ ] Component WIT revised.
- [ ] Wasmtime proof updated.
- [ ] Jco/browser Worker proof updated.
- [ ] TypeScript Worker API skeleton added.
- [ ] State provider abstraction added.
- [ ] IndexedDB cache schema added.
- [ ] Limits/cancellation added.
- [ ] Upstream blockers documented.
