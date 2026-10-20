# Local protocol-29 RPC parity runbook

This procedure captures the `local-add-i32` fixture from a **local Stellar RPC
pinned to protocol 29**, the same protocol the repository's `soroban-env-host`
29.0.2 pin (and the live workbench) runs.

## Why a local node

The `native-sac-*` fixtures come from public Testnet, which only hosts the
built-in Stellar Asset Contract we can invoke without deploying anything. A local
quickstart node lets us deploy the custom `add-i32` wasm and capture a
**custom-wasm** parity case. The host's replay-safety guard
(`check_ledger_protocol_supported`) rejects any ledger protocol other than 29,
and raw CPU instruction metering differs between protocols, so the node must run
protocol 29 for both sides to meter identically.

## Actual result (`local-add-i32`, captured 2026-10-20)

Captured against a local protocol-29 quickstart node (`stellar/quickstart:testing`,
core 29.0.0 embedding `soroban-env-host` 29.0.0), custom add-i32 wasm. Verdicts vs
the recorded RPC `simulateTransaction`: result (`ScVal::I32(42)`), footprint (2
read-only, 0 read-write), auth (0), contract events (0), read/write bytes,
instructions (295 293 RpcDefault = 245 293 raw + 50 000) and resource fee
(12 605 stroops) all **match** exactly.

(The earlier protocol-28 capture, replayed by the protocol-28.0.2 host against a
28.0.0 core, left a +5 647-instruction / +14-stroop patch-level residual; the
29.0.0 core and the 29.0.2 pin meter this contract identically.)

## Prerequisites

- **Docker daemon running.** Docker Desktop is installed; start it with
  `open -a Docker` and wait ~30–90 s (`docker ps` should succeed).
- **stellar CLI** (27.x): `stellar --version`.
- Repo deps installed: `pnpm install`.

## 1. Start the local protocol-29 RPC

`stellar container start` runs a quickstart node (Stellar core + RPC + Horizon +
friendbot) on port 8000. The `local` network supports `--protocol-version`:

```sh
stellar container start local --protocol-version 29 --name p29
```

This exposes:

| service   | URL                                  |
| --------- | ------------------------------------ |
| RPC       | `http://localhost:8000/rpc`          |
| friendbot | `http://localhost:8000/friendbot`    |

Friendbot is enabled by default in local mode. Fund any account with
`GET http://localhost:8000/friendbot?addr=<G...>`. Watch startup / tail logs:

```sh
stellar container logs p29
```

Wait until the RPC reports healthy (the log shows core catching up and RPC
serving). Quick check:

```sh
curl -s http://localhost:8000/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

The local quickstart network passphrase is the standalone default:
`Standalone Network ; February 2017`.

## 2. Register the network + a funded identity (stellar CLI)

```sh
stellar network add local \
  --rpc-url http://localhost:8000/rpc \
  --network-passphrase "Standalone Network ; February 2017"

# Generate + friendbot-fund a deployer identity on the local network.
stellar keys generate deployer --network local --fund
```

## 3. Build + deploy the add-i32 fixture contract

Build the wasm (writes `fixtures/contracts/add_i32.wasm`):

```sh
pnpm run build:fixture-contract
```

Deploy it and capture the resulting contract id:

```sh
stellar contract deploy \
  --wasm fixtures/contracts/add_i32.wasm \
  --source deployer \
  --network local
# → prints the deployed contract id: C...
```

Optional sanity invocation (`add(a,b)`):

```sh
stellar contract invoke --id <C...> --source deployer --network local \
  -- add --a 7 --b 35        # → 42
```

## 4. Capture the protocol-29 parity fixture

The capture script honors these env vars:

- `SOROBAN_RPC_URL` — the local RPC endpoint.
- `FRIENDBOT_URL` — friendbot base; the script appends `/?addr=<G...>` itself, so
  set it to `http://localhost:8000/friendbot` (no trailing `/?addr=`).
- `SOROBAN_ALLOW_HTTP=1` — required for plain-http `localhost` (the SDK's
  `rpc.Server` rejects non-TLS URLs otherwise).
- `SOROBAN_NETWORK=local-p29` — tags the fixture's `network` field.
- `SOROBAN_NETWORK_PASSPHRASE` — the local standalone passphrase (governs
  signing + networkId; the `local-add-i32` contract id comes from env, so it is
  passphrase-independent).
- `LOCAL_CONTRACT_ID=<C...>` — the deployed add-i32 contract id from step 3.

The one command (writes `fixtures/parity/local-add-i32.json`):

```sh
SOROBAN_RPC_URL=http://localhost:8000/rpc \
FRIENDBOT_URL=http://localhost:8000/friendbot \
SOROBAN_ALLOW_HTTP=1 \
SOROBAN_NETWORK=local-p29 \
SOROBAN_NETWORK_PASSPHRASE="Standalone Network ; February 2017" \
LOCAL_CONTRACT_ID=<C...> \
pnpm run capture:parity local-add-i32
```

The script funds a throwaway source account via friendbot, simulates
`add(7, 35) -> 42` against the local RPC, and snapshots the footprint entries +
all `ConfigSetting` entries so the fixture replays offline with zero needs-state
round trips. On success it logs `protocol=29`.

## 5. Rerun the differential harness

```sh
pnpm --filter @theahaco/soroban-sim test
```

All three fixtures are captured at protocol 29 and match the protocol-29 host
exactly. `local-add-i32` is already wired into the
`FIXTURES` array in
`packages/soroban-sim/src/differential/differential.test.ts` and passes.

## Stop the network

```sh
stellar container stop p29
```

The quickstart container is started with `--rm`, so stopping it removes it and
its ledger state. Re-running step 1 starts a fresh protocol-29 network (you will
need to redeploy the contract and recapture).
