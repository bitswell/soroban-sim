# soroban-sim-preview

The reactor behind `@theahaco/soroban-sign-dialog`'s preview: the smallest
build of the Soroban host a wallet's signing preview needs, compiled to
`wasm32-wasip1`. Not published to crates.io; the package build
(`packages/soroban-sign-dialog/scripts/build.mjs`) compiles it.

## One build per protocol

Each build links exactly one host, chosen by feature:

| Feature | Host | Output |
|---|---|---|
| `p29` (default) | soroban-env-host / soroban-simulation 29.0.2 | `soroban-sim-preview-p29.wasm` |
| `p30` | soroban-env-host / soroban-simulation 30.0.0 | `soroban-sim-preview-p30.wasm` |

```sh
cargo build -p soroban-sim-preview --release --target wasm32-wasip1 --no-default-features --features p30
```

The engine downloads the build matching the network's `protocolVersion`, and
`np_host_protocol()` lets it check what it loaded. A run whose ledger header
names another protocol is refused. The crate depends on the host directly,
not on `soroban-sim-core`, because core pins the workspace's single host.

When a network upgrades: add a feature and a `BUILDS` entry in
`packages/soroban-sign-dialog/src/preview/soroban-sim-preview.js` (the package
build checks the two agree), and drop the build no network runs any more.

## Interface

Three exports: `np_alloc(len)`, `np_call(ptr, len) -> (len << 32 | ptr)` and
`np_host_protocol()`. A call is one op byte and a little-endian payload; Stellar
values inside are raw XDR blobs (`u32` length, then bytes).

| Op | Payload | Reply |
|---|---|---|
| `1` provide | `n`, `n × (LedgerEntry, liveUntil + 1 or 0)`, `m`, `m × LedgerKey` (absent) | `0` |
| `2` reset | | `0` |
| `3` run | protocol, sequence, timestamp (`u64`), network id (32 bytes), base reserve, `TransactionEnvelope`, mode (`0` record, `1` enforce), and for enforce: stub verifiers, then per hinted account its rule-id lists and `(verifier, key)` signers | see below |

A run replies `0` (complete) with the invoke result, contract error codes
(each with the id of the contract that raised it, or empty for the host),
recorded authorization entries, contract events, ledger diffs, instructions,
memory, `SorobanTransactionData` and a diagnostics tail; `1` (needs state)
with the ledger keys to fetch; or `2` (error) with a message. Reads of keys
nobody provided stop the run with needs-state, as soroban-sim's `simulate`
does, so the embedder fetches exactly what the transaction touches.

**record** runs `RecordingInvocationAuthMode::recording(true, false)`, the
mode RPC's `simulateTransaction` uses, and returns the authorization tree the
host records by itself.

**enforce** runs the request's own entries. For each hinted account it fills
the credential with `{ context_rule_ids, signers: { External(verifier, key)
=> 64 zero bytes } }` and, in its in-memory ledger only, replaces each named
verifier contract with `stub/stub_verifier.wasm`, whose `verify` accepts
anything. The account's `__check_auth` then applies its own rules, so the
verdict means "accepted if this key signs". The stub's source is
`fixtures/contracts/preview-stub-verifier`; it rebuilds byte for byte with
`cargo build --target wasm32v1-none --profile contract`.

## Tests

`tests/fixture.rs` replays `fixtures/perch-capture.json`, a native run of the
Perch contracts (stellar-registry__perch `f0275f4`) on a standalone fork: a
grant for `transfer` on the native asset contract capped at 10 XLM per 100
ledgers, 3 XLM already spent. With the stub verifier it must reach the
verdicts the real-key capture reached (5 XLM accepted, 8 XLM refused with
contract error 5, 2 XLM accepted), and the recording must leave out the
unused 4 XLM entry. `fixtures/multi-party.json` adds a request two parties
authorize (`fixtures/contracts/preview-two-party`): the hinted account's
policy accepts, the other party has not signed, so the enforcing run fails
with no error from the account while the recording succeeds. Its generator is
the ignored `write_multi_party_fixture` test. Run them under both hosts:

```sh
cargo test -p soroban-sim-preview
cargo test -p soroban-sim-preview --no-default-features --features p30
```
