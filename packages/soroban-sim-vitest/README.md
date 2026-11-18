# @theahaco/soroban-sim-vitest

Vitest suites for Soroban contracts that run unchanged on two environments:

- **soroban-sim** (the default): the suite's setup runs once on a
  `soroban-sim serve`, its result is exported as a snapshot, and every test
  gets a server of its own started from that snapshot. Tests are isolated
  and run in parallel, and the snapshot is cached on disk, so a later run
  skips setup.
- **local**: a local network that is already running (quickstart). Setup
  runs once per test, with fresh accounts funded through friendbot, so tests
  share no keys and no contracts.

Test code receives an environment object and nothing else: the RPC URL, the
network passphrase, an `rpc.Server`, funded signers, the suite's Wasm, and
whatever setup returned. Which environment runs is configuration.

The package is private to this repository for now (not published to npm).

## A suite

```ts
import { nativeToScVal } from '@stellar/stellar-sdk'
import { expect } from 'vitest'
import { defineSuite, deployContract, invoke, read } from '@theahaco/soroban-sim-vitest'

const u32 = (n: number) => nativeToScVal(n, { type: 'u32' })

const { test } = defineSuite({
  name: 'storage example',
  signers: ['admin', 'alice'],
  wasm: { storage: new URL('./storage.wasm', import.meta.url) },
  async setup({ signers, wasm, ...net }) {
    const contractId = await deployContract(net, signers.admin, wasm.storage)
    await invoke(net, signers.admin, contractId, 'put_persist', [u32(1), u32(7)])
    return { contractId }
  },
})

test('reads what setup wrote', async ({ env }) => {
  expect(await read(env, env.signers.alice, env.setup.contractId, 'get_persist', [u32(1)])).toBe(7)
})
```

`test` is Vitest's own, extended with an `env` fixture, so `test.skip`,
`test.each` and the rest work as usual. The fixture starts the test's
environment when the test first asks for `env`, and stops it when the test
ends. Run a file's tests in parallel with `sequence.concurrent` in the Vitest
config (as this package's own config does) or `test.concurrent`.

- **`signers`**: names of throwaway keypairs derived from a built-in seed and the name.
  Each starts with 10,000 XLM: friendbot's amount on the local network, set
  with `fork_setBalance` on soroban-sim. The keys are never real; do not fund
  them anywhere else.
- **`wasm`**: files setup deploys, read once and handed to setup and tests as
  `Buffer`s.
- **`setup(ctx)`**: deploys, funds and writes through `ctx`, and returns what
  the tests need. The value must survive JSON (it is cached as JSON); tests
  receive the JSON copy on both environments.
- **`cacheFiles`**: other files setup depends on (see the cache key below).

`deployContract`, `invoke`, `read` (a simulation, nothing sent), `uploadWasm`
and `submit` (any operation) work on both environments. Each takes the context
or `env`, a signer, and the call. You can also use `env.rpc` or any other
client with `env.rpcUrl` and `env.networkPassphrase`.

This package's own suites are in [`test/`](./test): `example.test.ts` is the
example suite, `isolation.test.ts` checks that two tests writing the same key
at once each read back their own value, and `cache.test.ts` checks the cache.

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

## The setup cache (soroban-sim)

A cached setup is a directory under the cache directory, named by a hash of
everything that decides the snapshot:

- setup's source (`setup.toString()`), the suite's name, its signer names and
  the built-in seed;
- the contents of each `wasm` file and each `cacheFiles` file;
- the `soroban-sim` binary: its `--version` and a hash of the file, since a
  local build keeps its version number;
- the base snapshot file's contents.

Setup's source does not include the helpers it calls. When setup imports a
helper module of your own, list that module in `cacheFiles`, or a change to
it will not rerun setup.

To bypass the cache for a run, set `SOROBAN_TEST_CACHE=off`. To clear it,
run `pnpm --filter @theahaco/soroban-sim-vitest cache:clear`, call
`clearCache(dir)`, or delete the directory. Entries are written aside and
renamed into place, so parallel workers that run the same setup do not
corrupt each other. An entry that cannot be read (a file deleted by hand,
say) is moved aside and replaced by the next run's fresh setup.

## What differs between the two environments

The same suite exercises different machinery, so a pass on one is not a
pass on the other.

| | soroban-sim | local network |
|---|---|---|
| Setup | once per suite (per Vitest worker), then from the cache | once per test |
| State | one server per test, started from the setup's snapshot | one shared network: every test's accounts and contracts stay on it |
| Isolation | a test's writes live only in its own server | each test has its own keys and contracts, but they share one ledger |
| Ledgers | one per transaction, closed inside `sendTransaction` | one per second; a transaction waits for the next close |
| Requests | each server answers one request at a time | concurrent |
| Classic operations | none (no payments, trustlines or `createAccount`); signers are funded with `fork_setBalance` | all; signers are funded by friendbot |
| History | `getTransaction` and `getEvents` cover only the test's own transactions; `getLedgers` and `getTransactions` are not served | full |
| Clock | starts at the setup's ledger time and follows the wall clock | follows the wall clock |
| Speed (this package's suites, one laptop) | about 0.6 s for 18 tests with setup, 0.4 s from the cache | about 40 s for the 11 that run there |

A suite that passes on soroban-sim can still fail on a local network on
timing: a test that assumes a transaction is visible as soon as
`sendTransaction` returns, that sends from one account in parallel, or that
needs a ledger to close by itself. The helpers here wait for each
transaction's result, which holds on both. See
[`docs/rpc-facade.md`](../../docs/rpc-facade.md) for everything soroban-sim's
RPC serves and how its clock moves.
