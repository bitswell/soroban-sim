# Architecture

## Boundary

Soroban Sim wraps the Soroban simulator in a WASI Preview 2 component. It does **not** put a component boundary between the Soroban host and individual contracts.

```text
Browser UI
  -> TypeScript API + Web Worker
  -> Jco-transpiled WASI Preview 2 component
  -> soroban-simulation
  -> soroban-env-host
  -> soroban-wasmi
  -> existing wasm32v1-none contract bytes
```

Individual contracts stay normal Soroban core Wasm. The host loads contract code through the same Wasmi path used by native Soroban host execution.

## Crates and packages

- `crates/soroban-sim-core`: Rust simulation core. Owns in-memory snapshots, fixture construction, simulation call, and deterministic output encoding.
- `crates/soroban-sim-component`: WIT export wrapper for `wasm32-wasip2`.
- `packages/soroban-sim`: TypeScript package placeholder around Jco output.
- `packages/web-demo`: Vite + Playwright browser Worker proof.

## Current WIT

`wit/simulator.wit` exports:

- `run-fixture() -> result<list<u8>, string>` for Milestone 0 proof.
- `simulate(request) -> result<outcome, string>` for early host-function simulation.

The request carries XDR bytes for host function, source account, and ledger entries. Ledger context is a small WIT record because `LedgerInfo` is host-side context, not Stellar XDR.

Milestone 0 keeps network costs in a deterministic Rust fixture config. Later interface revision should encode network config as either:

1. config-setting ledger entries loaded through `NetworkConfig::load_from_snapshot`; or
2. a canonical local byte encoding for `NetworkConfig`.

Avoid pretending this is Stellar XDR until an actual XDR type exists.

## Fixture execution path

The M0 fixture:

1. builds `fixtures/contracts/add-i32` as `wasm32v1-none`;
2. stores the compiled contract bytes in `fixtures/contracts/add_i32.wasm`;
3. creates `ContractCode` and `ContractData` ledger entries in memory;
4. invokes `add(40, 2)` through `HostFunction::InvokeContract`;
5. runs `soroban-simulation::simulate_invoke_host_function_op`;
6. encodes invocation result, auth, events, diagnostics, transaction data, measurements, and modified entries into deterministic bytes;
7. compares native / Wasmtime / browser Worker SHA-256.

## State-loading model for Milestone 1

Snapshot lookups must distinguish:

- present: ledger entry plus actual TTL;
- absent: known absence;
- unknown: cache miss / not yet resolved.

`SnapshotSource::get` returns `Option<EntryWithLiveUntil>`, so `None` already means absent to the host. Unknown cannot be represented as `None`.

Planned local protocol:

1. Snapshot source stores `Present`, `Absent`, or `Unknown` per key.
2. On unknown lookup, it records ledger-key XDR and aborts with a recognizable host error.
3. Wrapper sees recorded missing keys and returns `outcome::needs-state(keys)` instead of a completed simulation failure.
4. JavaScript fetches keys asynchronously via RPC or another provider.
5. Response, including known absence, is persisted in IndexedDB under exact context.
6. Simulation reruns deterministically from the beginning.

First implementation can discover one key per run. Batching comes after correctness.

## Cache identity

Browser cache keys must include:

- network passphrase or network ID;
- ledger sequence;
- optional transaction hash / transaction position;
- ledger-key XDR hash;
- protocol version where needed.

TTL must be preserved from source data. No synthetic `u32::MAX` TTL for transaction simulation.

## Browser model

The component runs in a dedicated Worker. Main-thread API should:

- create/terminate worker;
- pass explicit ledger context and deterministic seed;
- enforce iteration and input limits;
- support cancellation via Worker termination;
- never hold secret keys or request signatures.

## Non-goals kept out of the architecture

- Converting Soroban contracts into components.
- Describing all host functions in WIT.
- Static composition of contracts with simulator.
- Replacing Wasmi with browser-native `WebAssembly.instantiate` for contracts.
- Running ordinary WASI components as Soroban contracts.
