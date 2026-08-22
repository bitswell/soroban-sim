# Upstream notes

## Pins

Soroban Sim M0 pins:

- `rs-soroban-env` tag `v28.0.2`
- tag commit `5061e9c40ce6fc74ade9b9b3b49465b0cf7fdccb`
- `soroban-env-host = 28.0.2`
- `soroban-simulation = 28.0.2`
- `stellar-xdr = 28.0.0` through upstream crates
- `soroban-wasmi = 0.31.1-soroban.20.0.1`

Snapshot-source prior art inspected:

- fork-testing design: `stellar/rs-soroban-sdk#1448`
- custom snapshot-source support: `stellar/rs-soroban-sdk#1620`, commit `37badee96c252ab5a3b90a862f3dd2842668a751`
- transaction-granular snapshot source: `stellar/rs-soroban-sdk#1657`, branch/commit `b91d50521250c67b0a66898cba6654401baa8ea6`

## Snapshot-source draft observations

Useful design:

- reconstruct state immediately before a transaction or after a ledger;
- search transaction metadata, earlier transaction metadata, RPC when safe, earlier ledger metadata, and history archives;
- cache entries by ledger / transaction context / ledger-key hash;
- invalidate caches by XDR schema version.

Native assumptions to keep out of portable core:

- `cargo_metadata` for workspace root;
- `directories` system cache paths;
- filesystem JSON fixtures;
- filesystem locks;
- blocking `reqwest`;
- `flate2` / `zstd` archive decompression inside snapshot source;
- tracing subscriber initialization from environment;
- synthetic `u32::MAX` TTL for contract entries.

## Likely upstream contribution

Proposed smallest useful upstream patch:

> Make transaction snapshot storage and resolution backends injectable.

Shape:

- split ledger-entry resolution from storage/cache backend;
- keep current native constructor for tests;
- add in-memory backend for portable use and tests;
- hide Cargo metadata, system dirs, filesystem locks, blocking HTTP, and compression behind native features;
- preserve actual TTL where data sources provide it;
- make absent-vs-unknown explicit where possible.

## Local M1 adapter plan before upstream PR

Do not block local progress on upstream changes.

Implement in `soroban-sim-core`:

```rust
enum CachedEntry {
    Present { entry: LedgerEntry, live_until_ledger: Option<u32> },
    Absent,
    Unknown,
}
```

`SnapshotSource::get` plan:

1. If present, return entry + TTL.
2. If absent, return `Ok(None)`.
3. If unknown, record key XDR in the snapshot source and return a controlled `HostError`.
4. After simulation, if missing keys were recorded, return WIT `outcome::needs-state(keys)` instead of treating the host error as a contract failure.

Open question: choose the least-confusing `HostError` type/code for unknown. It must be recognizable by wrapper state, not by string matching.

## WASI/browser imports

Current component has no filesystem or socket imports, but does import WASI CLI/io/clock/random. This is likely from Rust `std`, Preview 2 ABI support, `getrandom`, and transitive crypto dependencies.

Potential upstream / local reductions:

- audit whether `getrandom` is retained only through unused crypto paths;
- test whether no-op custom getrandom backend removes `wasi:random/insecure-seed`;
- test `panic = "abort"` plus smaller std surface to reduce CLI imports;
- avoid `std::time`, environment, stdout/stderr in local code;
- keep ledger time and PRNG seed explicit regardless of imports.

## No fork yet

M0 required no fork or patch of `rs-soroban-env`, `rs-soroban-sdk`, Wasmi, Perch, Nido, or Stellar repositories.
