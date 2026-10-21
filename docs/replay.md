# Replaying real transactions

A network session's host is exact, but its transaction layer (envelope
validation, fee charging, rent and refunds, sequence numbers, signature
thresholds) is a port of stellar-core's, and a bug there would pass a
rehearsal that the network would reject ([#23], phase 5). `soroban-sim replay`
checks that layer against the network itself: it replays recent real mainnet
and testnet Soroban transactions through `Session::submit_with`, each on a fork
of exactly the state it applied against, and compares everything the network
recorded about it.

[#23]: https://github.com/theahaco/soroban-sim/issues/23

```sh
# Record a sample of the latest ledgers (read-only RPC; nothing is sent).
cargo run --release -p soroban-sim-cli -- replay fetch --network mainnet \
  --min-ledgers 55 --out mainnet.json.gz --report mainnet
# Replay fixtures offline.
cargo run --release -p soroban-sim-cli -- replay run fixtures/replay/*.json.gz --report fidelity
```

`replay run` writes `PREFIX.json` (format `soroban-sim-replay-report/1`) and
`PREFIX.md`: counts, coverage by tag (`fee-bump`, `sac`, `smart-account-auth`,
`address-auth`, `failed`, `restore`, `upload`, `create`), mismatch categories,
explained divergences with their causes, a row per call, and the worst
offenders. The exit code is 0 when no mismatch is unexplained.

The CI test `crates/soroban-sim-cli/tests/replay.rs` replays the committed
sample in `fixtures/replay` and fails on any unexplained mismatch.

## What is compared

For every transaction, against its `TransactionResult`, `TransactionMeta` (V4)
and fee-processing changes:

- the `TransactionResult` XDR: the result code, the fee charged after the
  refund, the operation result code and the success hash (which covers the
  return value and every event), and for a fee bump the inner result pair;
- the return value and the contract events;
- the host's diagnostic events (calls, returns, logs, errors);
- every after-image the transaction left: contract data and code, accounts,
  trustlines, and every TTL, plus every entry the session changed that the
  network did not;
- the fee charged up front, the refund, and the non-refundable, refundable and
  rent fees;
- core's `core_metrics` diagnostic counters: CPU instructions, memory, entries
  and bytes read and written, events and their size.

## How each pre-state is rebuilt

RPC's `getLedgerEntries` only serves its latest ledger. `fetch` takes a window
of recent ledgers with `getLedgers`, whose close meta records, for every entry
each transaction changed, its value before and after. For each sampled
transaction, an entry's value when the transaction applied is the after-image
of its last change before that point in the window, else the before-image of
its first change after it, else (nothing in the window touched it) its current
value from `getLedgerEntries`. The window is extended to the ledger RPC served
those entries at, so nothing can change unseen in between. Only the keys
Soroban transactions can read (their footprints, sources and fee sources, and
the network config) are indexed.

"When the transaction applied" follows core's ledger close:

1. Every transaction's fee is charged before any applies. The meta lists each
   transaction's fee change next to its apply, but its images are from the
   start of the ledger; changes are ordered by when core made them.
2. The classic phase applies in turn.
3. In the parallel Soroban phase (protocol 23+) core bumps every transaction's
   sequence number (`preParallelApply`) before any executes. The session bumps
   the source itself, so the source starts from the sequence its own bump
   found.
4. Stages run in order and the clusters of a stage in parallel. A read-only
   TTL bump (the entry only in the read-only footprint) is deferred (CAP-63):
   a later transaction sees it once a transaction of their cluster writes the
   entry, or once the stage ends, when a stage's bumps merge by maximum. A
   transaction in the same stage, another cluster, never sees it.
5. Refunds are made after every transaction applied, then upgrades.

The fork is then this pre-state, with the transaction's own fee given back to
its fee source; the session applies the envelope at the transaction's real
ledger and close time, with its transaction-set component's base fee as the
lane base fee and core's PRNG seed for it,
`sha256(txSetContentsHash || applyIndex as u64)`.

One value is in no meta: the Soroban state-size window that sets the rent
rate, which core rewrites every 64 ledgers at ledger close. RPC only serves
the current one, so `fetch` samples only ledgers after its last change
(`--min-ledgers` waits until enough have closed), and a fixture collects
several such windows (`--append`).

## What the replay found and fixed

The first replays differed from the network; each difference was a session
bug, fixed in the session:

- **CPU metering.** The session applied transactions with the host build that
  simulation needs (`recording_mode`), which charges an extra storage-map
  lookup on every write: CPU came out 0.13–0.3% above core's on every
  transaction that writes. Transactions now apply with a second build of the
  same release without that feature (the workspace's `soroban-env-host-apply`),
  and CPU matches to the instruction.
- **Fee bumps.** 98% of mainnet's Soroban transactions are fee-bumped; the
  session refused them. It now validates and applies them as
  `FeeBumpTransactionFrame` does: the outer fee and its rate against the
  inner, the fee source's signatures and balance, the inner transaction
  without its own fee check, the fee charged to and refunded to the fee
  source, the inner sequence consumed.
- **Inclusion fee.** The fee charged for inclusion is the bid capped at the
  transaction-set component's base fee per operation (a fee bump counts one
  more), not at the ledger's base fee.
- **Disk reads.** Classic entries (accounts, trustlines) and restored archived
  entries in a footprint are now metered against the declared disk-read bytes,
  as core does; only entries actually archived are restored.
- **Core's remaining checks**, in core's order: Soroban transactions may not
  carry a memo or muxed source (protocol 25+), footprint keys must be valid
  and within the key size limit, archived-entry indices must be sorted and
  point at persistent read-write entries, entries read and written must fit
  the network's entry size limits, an uploaded Wasm must fit the contract size
  limit, a starting sequence number is refused, pre-authorized-transaction
  signers are removed once used.
- **Read-only TTLs** only ever grow: the session wrote a TTL of 0 onto an
  expired temporary entry the host reported as absent.
- **Results.** Failed operations now carry core's result code (trapped,
  resource limit exceeded, entry archived, insufficient refundable fee) and
  the session builds the `TransactionResult` core records
  (`TxRecord::transaction_result`), which the RPC facade now serves too.
- **Entries from RPC** keep their sponsorship extension (`extXdr`).

## Explained divergences

| Id | Cause |
|---|---|
| `later-sequence-bump` | In a parallel Soroban phase core bumps every transaction's sequence before any executes, so a transaction whose footprint holds its own source account writes back the sequence number a later same-source transaction of its ledger set. The session applies one transaction per ledger: everything else matches; the source's sequence is this transaction's own. |

## The committed sample

`fixtures/replay/mainnet.json.gz` and `fixtures/replay/testnet.json.gz` hold
three windows recorded on 2026-10-21, stratified by call, outcome and auth
kind (rare kinds get four times the share):

| Network | Ledgers | Soroban txs in them | Sampled |
|---|---|---:|---:|
| mainnet | 65053377–65053413 | 4,389 | 113 |
| mainnet | 65053441–65053495 | 5,561 | 145 |
| testnet | 5305857–5305911 | 586 | 247 |

All 505 replay exactly: every result, return value, event, diagnostic event,
after-image, TTL, fee and core metric is the network's, CPU to the
instruction. 145 distinct calls; 180 fee bumps, 80 with address credentials of
which 25 go through a smart account's `__check_auth`, 39 direct Stellar Asset
Contract calls (and many more through contracts), 45 failed transactions, 4
with restores, 4 uploads and 3 deployments. The one explained divergence above
did not occur in this sample; it did in an earlier testnet window.

To grow the sample, run `replay fetch --append` into the same file over a few
windows; the replay test asks for at least 300 transactions, 40 distinct calls,
and at least one of each tag it checks.

## Limits

- Only Soroban `InvokeHostFunction` transactions are replayed. The session does
  not model `ExtendFootprintTtl` or `RestoreFootprint` operations or classic
  operations; a sampled one would show up as `rejected`. None occurred in the
  sampled windows.
- A transaction core rejected at apply time (included in the transaction set
  but failing validation against the state at apply) is charged its fee by
  core and refused by the session, which models refusal before inclusion; it
  would show up as `rejected`.
- The replay checks one transaction at a time on its own pre-state, so it says
  nothing about ordering effects between transactions; the session's own
  ordering is one transaction per ledger.
