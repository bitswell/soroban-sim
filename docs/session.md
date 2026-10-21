# Network sessions

A network session rehearses a whole multi-transaction, multi-signer setup on a
fork of a real network before it goes to mainnet ([#23]). Transactions apply in
order over forked state, each one seeing every earlier write. Every envelope
and every authorization entry is really signed and really verified, fees are
charged and refunded, and the clock moves between ledgers. Nothing is ever
submitted: throwaway keys stand in for every real signer, and the RPC client
refuses any method that is not a read.

[#23]: https://github.com/theahaco/soroban-sim/issues/23

## Quick start

```sh
cargo run -p soroban-sim-cli -- session check examples/session/perch-nido-bootstrap.yaml
cargo run -p soroban-sim-cli -- session run examples/session/perch-nido-bootstrap.yaml \
  --wasm-dir path/to/release-wasm --differential --report bootstrap
# -> bootstrap.json and bootstrap.md
```

`examples/session/perch-nido-bootstrap.yaml` is the Perch/Nido registry
bootstrap on mainnet: 34 envelopes, 31 of them applied, plus the negative
controls. `crates/soroban-sim-cli/tests/rehearsal.yaml` is a smaller plan that
runs offline over the repository's fixture contracts and uses every step kind
and signer adapter.

`soroban-sim session run` options:

| Option | Meaning |
|---|---|
| `--fork mainnet\|testnet\|URL` | The network to fork (default: the plan's `network`). |
| `--network-passphrase P` | Checked against the RPC's `getNetwork`. |
| `--snapshot FILE` | Fork a snapshot file instead (offline, reproducible). |
| `--save-snapshot FILE` | Save every base entry the run read, for offline replays. |
| `--wasm-dir DIR` | Where `upload` steps find Wasm by hash (repeatable). |
| `--differential` | Compare each prepared step with RPC `simulateTransaction`. |
| `--var NAME=VALUE` | Set a plan variable (repeatable). |
| `--report PREFIX` | Write `PREFIX.json` and `PREFIX.md` (default: `<plan>.report`). |
| `--keep-going` | Run the remaining steps after an unexpected failure. |

The exit code is 0 when every step did what the plan expected, 1 when a step
did not, and 2 on an error before or outside the steps.

## How it works

```text
Session (soroban-sim-core::session)
  prepare(): simulate (recording) -> sign auth entries -> re-simulate
             (enforcing, so signature checks are metered) -> signed envelope
  submit():  TxValidator -> Applier -> close the ledger
  ForkedLedger: overlay + logged overrides over a lazily fetched base
```

- **ForkedLedger.** Session writes and overrides live in an overlay over a
  read-through cache of the base (RPC `getLedgerEntries`, a snapshot file, or
  fixtures). The cache keeps what the base said, so an archived entry (RPC
  returns evicted entries with `liveUntilLedgerSeq = 0`) stays distinct from an
  absent one. Storage of a contract the session created is answered absent
  locally. Every fetch is logged with the ledger it was served at and the
  entry's last-modified ledger, which is the drift report.
- **TxValidator.** The subset of stellar-core's `TransactionFrame` a Soroban
  transaction meets before it applies: time and ledger bounds, minimum
  sequence number, sequence age and gap, extra signers, the sequence number,
  envelope signatures ported from core's `SignatureChecker` (the source's low
  threshold, then the operation's medium threshold, then `txBAD_AUTH_EXTRA`
  for an unused signature), the fee bid, the resource fee against the
  non-refundable fee of the declared resources, the network's per-transaction
  limits, and the source's balance above its reserve and liabilities. A
  rejected envelope pays nothing and reaches no ledger.
- **Applier.** The fee is charged and the sequence number consumed first, so a
  failed operation still pays. The host runs in enforcing mode over the
  declared footprint and instruction budget with a session module cache (as
  core keeps every live contract pre-parsed; without it the host charges full
  Wasm parsing and real budgets fail). Archived entries marked for restore get
  core's restored TTL, unmarked ones fail the operation, expired temporary
  entries are absent. Written bytes and events are checked against the
  declared and network limits, rent and events are charged against the
  refundable fee, and the rest is refunded.
- **Clock.** One ledger closes per applied transaction, 5 s apart by default.
  `advance` closes many at once in O(1); TTLs follow the sequence number, so
  expiry and archival follow from it.

## Signers

Keys are throwaway: `sha256("soroban-sim throwaway:" || label)` seeds the key.
A G account keeps its address, thresholds and signer weights; its real master
key's weight moves to a throwaway signer and the master drops to 0
(`substitute_master_key`), or a real signer is replaced by a throwaway of the
same weight (`substitute_signer`). The account's sub-entry count is kept, so its
reserve matches the real account. Each substitution is an override in the
report.

Authorization-entry signer adapters:

| Plan | What it produces |
|---|---|
| `classic: [key, …]` | A G account's `Vec<AccountEd25519Signature>`, verified by the host against the account's signers and medium threshold. |
| `classic: { keys, address_bound: true }` | The same as CAP-71 `AddressV2` credentials (the payload binds the address). |
| `oz: { digest: oz_rule_ids, … }` | An OpenZeppelin smart account's `AuthPayload`, `External` signers signing `sha256(payload ‖ rule ids XDR)`. |
| `oz: { digest: addr_oz_v1, … }` | The same, with the payload first bound to the account: `sha256("perch/account/auth-addr-v1" ‖ contract id ‖ payload)` (`domain:` overrides the tag). |
| `external: { verifier, key }` with an ed25519 key | 64-byte ed25519 signature over the digest. |
| … with a `secp256r1` key | ECDSA P-256 over `sha256(digest)`, low-s. |
| … with a `webauthn` key | A `webauthn.get` assertion whose challenge is the digest, as OZ's `WebAuthnSigData` XDR; `key_data` is the 65-byte key plus the credential id. |
| `delegated: { account: G…, keys }` | CAP-71: the account names `Delegated(G)` and the G's keys sign the address-bound payload in an `AddressWithDelegates` entry. |

`rule:` is an id, a list of ids, or `{ name: … }`, looked up with the account's
`get_context_rule(id)` when the step signs (rule ids move when rules change).

## Plan reference

A plan is YAML or JSON. Strings anywhere use `${name}` interpolation over plan
`vars` (evaluated lazily, in any order), values saved by steps, `--var`
values, `key.NAME` (the key's G address), `key.NAME.pk` (its public key, hex),
`ledger` and `time` (the ledger the next transaction applies in and its close
time) and `network.passphrase`.

```yaml
name: …
description: …
network: mainnet               # mainnet | testnet | { rpc: URL, passphrase: … }
options:
  source: "${theahaco}"        # default envelope source
  seconds_per_ledger: 5
  auth_expiration_ledgers: 100
  wasm_dir: wasm               # relative to the plan
  bytes_source: testnet        # fetch Wasm by hash, read-only
keys:
  theahaco: ed25519            # label = name
  admin: { ed25519: author-admin }
  hsm: secp256r1
  passkey: { webauthn: passkey, credential_id: "6372656431" }
vars:
  root: { contract_id: { deployer: "${theahaco}", salt: { sha256: "2026-04-24T13:41:00" } } }
  version: { view: { contract: "${root}", fn: current_version, args: [{ string: registry }] } }
  expiry: { ledger_plus: 40 }
signers:                       # auth-entry signers by address, for every step
  "${theahaco}": { classic: [theahaco] }
setup:                         # overrides before the first step
  - substitute_master_key: { account: "${theahaco}", key: theahaco }
  - fund: { account: "${theahaco}", xlm: 500 }
steps: [ … ]
```

Values (`vars`, `set`, `salt`, `to_ledger`, `xlm`): text, a number,
`{ contract_id: { deployer, salt } }`, `{ sha256: text }` (hex),
`{ ledger_plus: N }`, or `{ view: { contract, fn, args } }` (the rendered result).

Arguments are stellar-xdr's ScVal JSON (`{ string: … }`, `{ address: … }`,
`{ u32: 1 }`, `{ i128: "1" }`, `{ bytes: hex }`, `{ symbol: … }`,
`{ vec: [ … ] }`, `void`, …), plus `{ bytes_utf8: text }` and
`{ bytes_sha256: text }`. Interpolated numbers may be strings (`{ u32: "${n}" }`).

Overrides (`setup` and `override` steps), each logged with its `label`:
`substitute_master_key: { account, key }`,
`substitute_signer: { account, signer: G…, key }`,
`fund: { account, xlm | stroops }` (creates the account if needed),
`set_entry: { xdr: LedgerEntry base64, live_until }`,
`remove_entry: LedgerKey base64`.

Steps have a `name` and exactly one action:

| Action | Meaning |
|---|---|
| `invoke: { contract, fn, args }` | A contract call. |
| `upload: { file \| hash, skip_if_present }` | Upload Wasm; by default skipped when the code is already on the ledger, live or archived. |
| `deploy: { deployer, salt, wasm_hash, args }` | `CreateContractV2` with constructor arguments. |
| `deploy_sac: native` | The native asset's Stellar Asset Contract. |
| `envelope: base64` | Submit a signed envelope as is. |
| `view: { contract, fn, args }` | A read-only call; `fresh_fork: true` runs it on a fork without the session's writes and overrides. |
| `advance: { ledgers, seconds } \| { to_ledger } \| { to_time } \| { seconds }` | Close ledgers. |
| `set: { name: value }` | Set variables now (for example `{ ledger_plus: 40 }`). |
| `assert: [{ value, equals }]` | Compare values (derived addresses against known ones). |
| `override: { … }` | One override mid-session. |

Transaction steps also take `source`, `sign_with: [keys]` (default: the
classic signers registered for the source, else the key whose account is the
source), `auth: { address: signer }` (over the plan's `signers`),
`auth_expiration_ledgers`, `save_envelope: name`, and `hold: true` (prepare and
sign but do not submit; submit it later with `envelope: "${name}"`).

Every step may `save: name` its rendered result and set `expect`:
`{ equals: text }`, `{ value: ScVal JSON }`, or `{ fails: true | "text" }` (the
step must not apply, and the outcome must mention the text: `txBAD_AUTH`,
`txBAD_SEQ`, `3002`, …). A step without `expect` must succeed, and the run
stops at the first one that does not.

## The report

`PREFIX.json` (format `soroban-sim-session-report/1`) and `PREFIX.md` hold:
the fork point and host version; per-step outcome, fees (bid, resource,
non-refundable, refundable, charged, refunded, rent, events), CPU used against
declared, writes, restores, contract errors, and the matched signers; every
override; fees by payer with the largest fee bid each must cover; account
balances before and after; the final diff against the fork point; drift (the
ledgers fetches were served at and any entry modified after the fork ledger);
fetch counts; the differential results; and the safety section.

## Differential check

`--differential` compares each prepared step's recording pass with RPC
`simulateTransaction` of the same unsigned transaction: return value,
footprint, instructions, disk-read and write bytes, resource fee, and auth
invocations. A step that reads anything the session changed cannot be
simulated by the real network and is reported as skipped. On the bootstrap,
every comparable upload matches exactly and `root.deploy` matches except for a
1-stroop resource-fee difference.

## Safety

The session never submits. Rehearsal envelopes keep the real network id, so an
envelope signed by a real key would be valid on the real network. The
validator flags every envelope signature, and every G-account auth-entry
signature (including CAP-71 delegates), that verifies against a signer the
base ledger already has; on mainnet such a signature fails the run.
Smart-account `External` and passkey signatures are not checked yet.

## Fidelity and limits

Host-exact, envelope-approximate: contracts run in the same `soroban-env-host`
as the network's protocol (the session refuses any other), while the
transaction layer is a port of core's checks. Not modelled yet: classic
operations (funding is an override), fee-bump envelopes and muxed fee
sources, pre-auth signer removal after use, surge pricing, several
transactions per ledger and per-ledger limits, and core's PRNG seed. The `head`
fork reads RPC's latest ledger lazily, so a long session can mix ledgers;
the drift report shows whether it did.

The same session also runs behind an RPC facade, `soroban-sim serve --fork …`,
so existing scripts and stock tools rehearse themselves unchanged
([`docs/rpc-facade.md`](rpc-facade.md)). Later phases (see #23): a browser
session resource, replaying real mainnet transactions from their meta, an exact
history-archive checkpoint fork, and classic operations.
