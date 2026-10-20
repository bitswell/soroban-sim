# Milestone 0 feasibility

> Historical note: the original M0 investigation below used env-host 28.0.2.
> The live workbench now pins env-host/simulation 29.0.2 to match the network
> protocol; the current golden lives in `fixtures/golden/add_i32.fixture.json`.

## Sources reviewed

Local / registry sources inspected before implementation:

- `soroban-simulation 28.0.2`
  - `src/simulation.rs`
  - `src/network_config.rs`
  - `src/snapshot_source.rs`
  - `src/test/simulation.rs`
- `soroban-env-host 28.0.2`
  - `src/storage.rs` (`SnapshotSource`)
  - `src/e2e_invoke.rs` (`invoke_host_function_in_recording_mode`)
  - `src/ledger_info.rs`
  - `src/e2e_testutils.rs` fixture builders and default test config
- `soroban-env-common 28.0.2`
  - `src/meta.rs` protocol version `28`
- Snapshot-source draft branch:
  - `stellar/rs-soroban-sdk`, branch `snapshot-source-tx`, commit `b91d50521250c67b0a66898cba6654401baa8ea6`
  - `soroban-ledger-snapshot-source-tx/src/lib.rs`
  - `src/fetch/*`
  - `src/cache.rs`
- Local Perch / Nido repositories for conventions only; no files modified.

## What works

Acceptance item | Evidence
--- | ---
Native fixture simulation passes | `cargo test -p soroban-sim-core`
Simulator component builds for `wasm32-wasip2` | `cargo build -p soroban-sim-component --target wasm32-wasip2 --release`
Runs under Wasmtime | `pnpm run test:wasmtime`
Jco output runs in browser Worker | `pnpm run build:jco && pnpm run test:browser`
Native and browser/WASI results match | all compare `3b678efa6ece9309c861a0412b8e1bc45d4d449085217e76c0966b4d8ebe4bca`
No network / persistent filesystem access | component WIT imports no filesystem or sockets; fixture uses in-memory snapshot
Build/test commands documented | `README.md`, package scripts, CI workflow

## Commands run

```sh
pnpm run build:fixture-contract
cargo test -p soroban-sim-core
cargo test -p soroban-sim-component
cargo build -p soroban-sim-component --target wasm32-wasip2 --release
pnpm run build:jco
pnpm run test:wasmtime
pnpm run check:ts
pnpm run test:browser
```

## Fixture result

```text
ScVal::I32(42)
encoded output len: 388
encoded output sha256: 3b678efa6ece9309c861a0412b8e1bc45d4d449085217e76c0966b4d8ebe4bca
```

The fixture invokes real contract wasm bytes through `soroban-env-host` and `soroban-wasmi`; it is not a TypeScript model.

## Measured numbers

Environment: macOS arm64, Rust 1.97.1, Wasmtime 48.0.0, Chromium 151.

Metric | Value
--- | ---
component binary | 2.9 MiB
Jco core wasm | 2.88 MiB
Jco JS glue | 203 KiB
Wasmtime run | 0.05s real
Wasmtime max RSS | 34,668,544 bytes
Wasmtime peak memory footprint | 29,295,072 bytes
Browser direct Jco startup | 42.3 ms
Browser direct fixture execution | 11.0 ms
Browser heap delta | ~2.7 MB
Browser Worker startup | 47 ms
Browser Worker fixture execution | 10.7 ms

## Component imports

`jco wit target/wasm32-wasip2/release/soroban_sim_component.wasm` reports these WASI imports:

- `wasi:io/poll`
- `wasi:clocks/monotonic-clock`
- `wasi:io/error`
- `wasi:io/streams`
- `wasi:cli/stdout`
- `wasi:cli/stderr`
- `wasi:cli/stdin`
- `wasi:cli/environment`
- `wasi:cli/exit`
- `wasi:cli/terminal-*`
- `wasi:random/insecure-seed`

No filesystem or socket imports were present.

The clock/random/CLI imports come from Rust `std`, WASI Preview 2 support, `getrandom`, and upstream dependency graph. They are not used by Soroban ledger context or PRNG, which are explicit inputs. Still, reducing them is a follow-up blocker because the project wants minimal deterministic imports.

## Build complications / blockers

1. `soroban-simulation` compiles for `wasm32-wasip2` with the current `soroban-env-host 28.0.0` pin. No upstream source patch is needed.
2. Rust `wasm32-wasip2` emits WASI imports from `std`; Jco supplies browser shims through `@bytecodealliance/preview2-shim`.
3. `NetworkConfig` is not Stellar XDR. M0 uses deterministic fixture config. Production API needs a canonical encoding or config-setting snapshot loading.
4. `SnapshotSource::get` cannot represent unknown directly: `None` means absent. M1 must record missing keys and abort recognizably.
5. The transaction snapshot-source draft is native-oriented: Cargo metadata, project dirs, filesystem locks, blocking Reqwest, compression, and workspace fixtures are built in.
6. The draft snapshot source currently returns synthetic `u32::MAX` TTLs for contract entries. Transaction simulation must preserve actual TTL.
7. Browser Worker messages posted before module load were lost in the demo; fixed with a ready/result handshake.

## Conclusion

Milestone 0 architecture is feasible without forking upstream. Immediate next work: three-state in-memory snapshot and `needs-state` rerun loop.
