# @theahaco/soroban-sim-vitest

```ts
import { expect } from 'vitest'
import { ContractError, defineSuite } from '@theahaco/soroban-sim-vitest'

const storageWasm = new URL('./storage.wasm', import.meta.url)

const { test } = defineSuite({
  name: 'storage',
  wasm: [storageWasm],
  async setup(worker) {
    const admin = await worker.createAccount('admin')
    const alice = await worker.createAccount('alice')
    const storage = await admin.deploy(storageWasm)
    await admin.call(storage, 'put_persist', { key: 1, val: 7 })
    return { alice, storage }
  },
})

test('alice overwrites what setup wrote', async ({ setup: { alice, storage } }) => {
  expect(await storage.view('get_persist', { key: 1 })).toBe(7)
  await alice.call(storage, 'put_persist', { key: 1, val: 42 })
  expect(await storage.view('get_persist', { key: 1 })).toBe(42)
})

test('alice cannot send more XLM than she has', async ({ worker, setup: { alice } }) => {
  const xlm = await worker.xlm()
  const bob = await worker.createAccount('bob')
  const error = await alice.call(xlm, 'transfer', { from: alice, to: bob, amount: 20_000_0000000n }).catch((e) => e)
  expect(error).toBeInstanceOf(ContractError)
  expect(error.errorName).toBe('BalanceError')
})
```

Vitest tests for Soroban contracts, written as accounts acting on
contracts: no transactions, simulation, signing, polling or XDR in the test.
The same file runs unchanged on two environments:

- **soroban-sim** (the default): setup runs once on a `soroban-sim serve`,
  its state is exported as a snapshot, and every test gets a server of its
  own started from that snapshot. Tests are isolated and run in parallel,
  and the snapshot is cached on disk, so a later run skips setup.
- **local**: a local network that is already running (quickstart). Setup
  runs once per test, with fresh accounts funded through friendbot, so tests
  share no accounts and no contracts.

Which environment runs is configuration (`SOROBAN_TEST_ENV`), never test
code. The package is private to this repository for now (not published to
npm).

## Workers, accounts and contracts

A **`Worker`** is one network to test on: its own `soroban-sim serve`, or
the local network.

- `worker.createAccount(name)` creates an account funded with 10,000 XLM:
  friendbot's amount on the local network, set with `fork_setBalance` on
  soroban-sim. Its key is a throwaway derived from the name (and, on a local
  network, from the test), never real; do not fund it anywhere else.
- `worker.account(name)` returns an account created earlier, by the test or
  by setup.
- `worker.contract(id)` returns a contract already on the network, by its
  `C…` address.
- `worker.xlm()` returns the native asset (XLM) contract, deploying it first
  if the network lacks it.

An **`Account`** acts:

- `account.deploy(wasm, { args })` uploads a Wasm file (a path, URL or
  bytes), creates a contract from it with `args` for its constructor, and
  returns the contract.
- `account.call(contract, method, args)` sends a transaction the account
  signs and pays for, waits for its result, and returns the call's return
  value. `account.callRaw` returns the value with the transaction's hash,
  ledger, close time and full response.
- `account.balance()` returns its XLM balance in stroops.

A **`Contract`** is read:

- `contract.view(method, args)` simulates the call and returns its result.
  Nothing is signed or sent.
- `contract.getStorage(key, options)` reads one entry of its persistent or
  temporary storage.

Arguments are named and native, converted with the contract's spec (read
from its Wasm; a Stellar asset contract has its token and admin functions
built in):
numbers, `bigint`s for 64- and 128-bit integers, strings, arrays, objects
for structs, and accounts or contracts wherever the function takes an
address. Return values come back the same way. To pass XDR yourself, give an
array of `xdr.ScVal` instead of the object.

A failed call throws a typed error:

| Error | When | Carries |
|---|---|---|
| `ContractError` | the call failed with a contract's own error (`Error(Contract, #n)`) | `code`, `errorName` (from the called contract's error enum; undefined when the error came up from a contract it called), `events` |
| `InvocationError` | any other host error: a trap, failed authorization, a missing entry | `hostError` (such as `Error(WasmVm, InvalidAction)`), `events` |
| `TransactionError` | the network refused the transaction itself | `status`, `result` (such as `txBadSeq`) |

`ContractError` extends `InvocationError`. Both carry `contract`, `method`,
and the diagnostic events of the failed call; the message includes the
host's event log.

## Suites and setup

`defineSuite({ name, wasm, cacheFiles, setup })` returns `test`, Vitest's own
extended with two fixtures, and `sandbox` (see below):

- **`worker`**: the test's worker. On soroban-sim it is a server of the
  test's own, stopped when the test ends.
- **`setup`**: what setup returned, as the test's own copy. Accounts and
  contracts in it are bound to the test's worker; everything else is JSON
  (setup's result is cached as JSON, so it must survive it).

Setup receives a worker of its own. On soroban-sim it runs once for the
suite (per Vitest worker), and its state becomes the snapshot every test
starts from. On a local network it runs again for every test, against that
test's accounts.

- **`wasm`**: the Wasm files setup deploys. Their contents are part of the
  cache key, and setup may deploy no others (it throws, naming the file), so
  a changed contract always reruns setup. Tests may deploy anything.
- **`cacheFiles`**: files setup depends on besides the Wasm and the test
  file itself (see the cache key below).

`test.skip`, `test.each` and the rest work as usual. Run a file's tests in
parallel with `sequence.concurrent` in the Vitest config (as this package's
own config does) or `test.concurrent`.

For tests without a shared setup, import `test` itself: each test receives a
`worker` of its own and nothing else.

```ts
import { test } from '@theahaco/soroban-sim-vitest'

test('alice deploys and calls', async ({ worker }) => {
  const alice = await worker.createAccount('alice')
  const storage = await alice.deploy(storageWasm)
  await alice.call(storage, 'put_persist', { key: 1, val: 3 })
})
```

Outside a test, `await Worker.init()` returns a worker for the configured
environment, and `await worker.tearDown()` stops it.

### The escape hatch

`worker.rpcUrl`, `worker.networkPassphrase` and `worker.rpc` (an
`rpc.Server`) reach the network directly, and `account.keypair` is the
account's key, for building any transaction by hand.

## Sandbox controls (soroban-sim only)

| Control | soroban-sim admin method |
|---|---|
| `account.setBalance(stroops)` | `fork_setBalance` |
| `contract.setStorage(key, value, options)`, `contract.removeStorage(key, options)` | `fork_setLedgerEntry`, `fork_removeLedgerEntry` |
| `worker.advanceLedgers(n)` | `fork_advanceLedgers` |
| `worker.setTime(date or Unix seconds)` | `fork_setTime` |

`advanceLedgers` and `setTime` return the next ledger's sequence number and
close time; `worker.latestLedger()` (on both environments) returns the last
closed one. Time only moves forward. Storage keys and values are native
values or `xdr.ScVal`s; give `keyType` and `valueType` (as `nativeToScVal`'s
`type`, such as `'u32'`) when the stored type is not the one `nativeToScVal`
picks (a whole number becomes a `u64`). `durability` is `persistent` (the
default) or `temporary`.

A local network has no way to do any of this, so on a local network each
control throws `SandboxOnlyError`; none of them silently does nothing. A
suite's `sandbox` (and `worker.sandbox`) is true on soroban-sim, so a test
that needs a control skips elsewhere:

```ts
const { test, sandbox } = defineSuite({ /* … */ })

test.skipIf(!sandbox)('the vote closes after a day', async ({ worker, setup: { alice, vote } }) => {
  await worker.setTime((await worker.latestLedger()).closeTime + 86_400)
  await expect(alice.call(vote, 'cast', { choice: 1 })).rejects.toMatchObject({ code: 3 })
})
```

The harness sends its transactions with no upper time bound, so moving time
ahead never makes them too late. A transaction you build yourself with a
bound set from the wall clock (`setTimeout(300)`) is refused once
`setTime` moves past it.

## Running

```sh
pnpm --filter @theahaco/soroban-sim-vitest test         # soroban-sim
pnpm --filter @theahaco/soroban-sim-vitest test:local   # a local network
```

In this repository, the Vitest config uses the workspace's own build
(`target/release/soroban-sim`, else `target/debug/soroban-sim`) unless
`SOROBAN_SIM_BIN` names another. Build it with
`cargo build --release -p soroban-sim-cli`.

For the local environment, start a network first, for example
`stellar container start local` or
`docker run --rm -p 8000:8000 stellar/quickstart:testing --local --enable rpc`,
and wait until friendbot answers.

| Variable | Meaning | Default |
|---|---|---|
| `SOROBAN_TEST_ENV` | `soroban-sim` or `local` | `soroban-sim` |
| `SOROBAN_SIM_BIN` | The `soroban-sim` binary | `soroban-sim` on `PATH` |
| `SOROBAN_SIM_SNAPSHOT` | The snapshot setup's server starts from | [`snapshots/local-network.json`](./snapshots/local-network.json) |
| `SOROBAN_TEST_CACHE` | `on`; `off` runs setup and neither reads nor writes the cache | `on` |
| `SOROBAN_TEST_CACHE_DIR` | Where cached setups live | `node_modules/.cache/soroban-sim-vitest` |
| `SOROBAN_TEST_RPC_URL` | The local network's RPC | `http://localhost:8000/rpc` |
| `SOROBAN_TEST_FRIENDBOT_URL` | Its friendbot | `/friendbot` on the RPC's host |

The bundled snapshot holds the settings and latest header of a fresh
quickstart local network (protocol 30, captured with
`soroban-sim snapshot capture`), so by default soroban-sim and the local
network share a passphrase (`Standalone Network ; February 2017`), fee
schedule and limits. The base snapshot also fixes the protocol.

Running a suite against a fork of a real network (mainnet, testnet) is not
supported yet. It is planned as a follow-up once exports of live forks are
complete on main.

This package's own suites are in [`test/`](./test): `example.test.ts` is the
example suite, `isolation.test.ts` checks that two tests writing the same key
at once each read back their own value, `sandbox.test.ts` covers the
controls (and their refusal on a local network), `worker.test.ts` the plain
`test`, `errors.test.ts` which contract an error's name comes from, and
`cache.test.ts` the cache.

## The setup cache (soroban-sim)

A cached setup is a directory under the cache directory, named by a hash of
everything that decides the snapshot:

- setup's source (`setup.toString()`), the suite's name and the built-in
  seed accounts' keys derive from;
- the contents of the test file that defines the suite, so a constant or
  helper function in it that setup uses reruns setup when it changes (as
  does any other edit to the file);
- the contents of each `wasm` file and each `cacheFiles` file;
- the `soroban-sim` binary: its `--version` and a hash of the file, since a
  local build keeps its version number;
- the base snapshot file's contents.

The key does not cover the modules the test file imports. When setup uses a
helper module of your own, list that module in `cacheFiles`, or a change to
it will not rerun setup.

To bypass the cache for a run, set `SOROBAN_TEST_CACHE=off`. To clear it,
run `pnpm --filter @theahaco/soroban-sim-vitest cache:clear`, call
`clearCache(dir)`, or delete the directory. Entries are written aside and
renamed into place, so parallel workers that run the same setup do not
corrupt each other. An entry that cannot be read (a file deleted by hand,
say) is not repaired: the run fails with an error naming the entry, and
clearing the cache fixes it.

## What differs between the two environments

The same suite exercises different machinery, so a pass on one is not a
pass on the other.

| | soroban-sim | local network |
|---|---|---|
| Setup | once per suite (per Vitest worker), then from the cache | once per test |
| State | one server per test, started from the setup's snapshot | one shared network: every test's accounts and contracts stay on it |
| Isolation | a test's writes live only in its own server | each test has its own accounts and contracts, but they share one ledger |
| Ledgers | one per transaction, closed inside `sendTransaction` | one per second; a transaction waits for the next close |
| Requests | each server answers one request at a time | concurrent |
| Classic operations | none (no payments, trustlines or `createAccount`); accounts are funded with `fork_setBalance` | all; accounts are funded by friendbot |
| Sandbox controls | all | none: each throws `SandboxOnlyError` |
| History | `getTransaction` and `getEvents` cover only the test's own transactions; `getLedgers` and `getTransactions` are not served | full |
| Clock | starts at the setup's ledger time and follows the wall clock; `setTime` and `advanceLedgers` move it ahead | follows the wall clock |
| Speed (this package's suites, one laptop) | about 0.6 s for 34 tests with setup, 0.5 s from the cache | about 40 s for the 24 that run there |

A suite that passes on soroban-sim can still fail on a local network on
timing: a test that assumes a transaction is visible as soon as
`sendTransaction` returns, that sends from one account in parallel, or that
needs a ledger to close by itself. `call` and `deploy` wait for each
transaction's result, which holds on both. See
[`docs/rpc-facade.md`](../../docs/rpc-facade.md) for everything soroban-sim's
RPC serves and how its clock moves.
