import { Asset, Operation, rpc } from '@stellar/stellar-sdk'
import { Account } from './account.ts'
import { resolveConfig, SEED, type Config, type EnvironmentKind } from './config.ts'
import { Contract } from './contract.ts'
import { SandboxOnlyError } from './errors.ts'
import { ACCOUNTS, ADMIN, ADOPT, DEPLOYS } from './internal.ts'
import { RUN_NONCE, deriveKeypair } from './keys.ts'
import { rpcCall, startServer } from './server.ts'
import { send } from './transactions.ts'

/** Every account starts with this balance on both environments (friendbot's amount). */
export const FUNDING_XLM = '10000'

export interface WorkerOptions {
  /** The default reads SOROBAN_TEST_ENV and the other variables (see the README). */
  config?: Config
  /** soroban-sim: the snapshot the worker's server starts from; the default is the configured base. */
  snapshot?: string
  /**
   * Derives each account's key from its name. On soroban-sim the default is
   * fixed, so the same name is the same account on every run; on a local
   * network it is new for every worker, so workers share no accounts.
   */
  seed?: string
}

/** The next ledger after a time move: its sequence number and close time (Unix seconds). */
export interface NextLedger {
  ledger: number
  closeTime: number
}

interface Backend {
  url: string
  fund(address: string): Promise<void>
  stop(): Promise<void>
}

let localWorkers = 0

/**
 * A network to test on, and the accounts created on it: a `soroban-sim
 * serve` of its own, or a running local network. Create one with
 * `Worker.init()` (or take the `worker` a test receives), and call
 * `tearDown()` when done.
 */
export class Worker {
  readonly environment: EnvironmentKind
  /** True where the sandbox controls work (setBalance, setStorage, advanceLedgers, setTime): on soroban-sim. */
  readonly sandbox: boolean
  readonly rpcUrl: string
  readonly networkPassphrase: string
  /** The RPC client, for anything the worker does not wrap. */
  readonly rpc: rpc.Server
  readonly #backend: Backend
  readonly #seed: string
  readonly #accounts = new Map<string, Account>();
  /** While setup runs: the hashes of the Wasm the suite lists. */
  [DEPLOYS]: Set<string> | undefined
  #xlm: Promise<Contract> | undefined

  private constructor(environment: EnvironmentKind, backend: Backend, client: rpc.Server, passphrase: string, seed: string) {
    this.environment = environment
    this.sandbox = environment === 'soroban-sim'
    this.rpcUrl = backend.url
    this.networkPassphrase = passphrase
    this.rpc = client
    this.#backend = backend
    this.#seed = seed
  }

  /** Starts a soroban-sim server of the worker's own, or connects to the local network, per the configuration. */
  static async init(options: WorkerOptions = {}): Promise<Worker> {
    const config = options.config ?? resolveConfig()
    const local = config.environment === 'local'
    const backend = local ? localBackend(config) : await simBackend(config, options.snapshot ?? config.sim.snapshot)
    try {
      const client = new rpc.Server(backend.url, { allowHttp: backend.url.startsWith('http:') })
      const { passphrase } = await client.getNetwork()
      const seed = options.seed ?? (local ? `${SEED}/local/${RUN_NONCE}/worker-${localWorkers++}` : SEED)
      return new Worker(config.environment, backend, client, passphrase, seed)
    } catch (e) {
      await backend.stop()
      throw e
    }
  }

  /** Creates an account with a throwaway key derived from `name`, funded with 10,000 XLM. */
  async createAccount(name: string): Promise<Account> {
    if (this.#accounts.has(name)) {
      throw new Error(`account ${JSON.stringify(name)} already exists; use worker.account(${JSON.stringify(name)})`)
    }
    const account = new Account(this, name, deriveKeypair(this.#seed, name))
    this.#accounts.set(name, account)
    try {
      await this.#backend.fund(account.address)
    } catch (e) {
      this.#accounts.delete(name)
      throw e
    }
    return account
  }

  /** An account created earlier on this worker, or by the suite's setup. */
  account(name: string): Account {
    const found = this.#accounts.get(name)
    if (!found) {
      const known = [...this.#accounts.keys()].map((n) => JSON.stringify(n)).join(', ')
      throw new Error(`no account ${JSON.stringify(name)} on this worker (it has ${known || 'none'}); create it with worker.createAccount`)
    }
    return found
  }

  /** A contract already on the network, by its `C…` address. */
  contract(id: string, wasmHash?: string): Contract {
    return new Contract(this, id, wasmHash)
  }

  /** The native asset (XLM) contract, deployed first if the network does not have it yet. */
  xlm(): Promise<Contract> {
    this.#xlm ??= this.#nativeAsset().catch((e) => {
      this.#xlm = undefined
      throw e
    })
    return this.#xlm
  }

  async #nativeAsset(): Promise<Contract> {
    const asset = Asset.native()
    const sac = new Contract(this, asset.contractId(this.networkPassphrase))
    if (await this.#exists(sac.id)) return sac
    // Anyone may deploy it; a key of the worker's own pays, outside the accounts tests see.
    const deployer = deriveKeypair(this.#seed, '\0native-asset-deployer')
    await this.#backend.fund(deployer.publicKey())
    try {
      await send(this, deployer, Operation.createStellarAssetContract({ asset }), { contract: sac.id, method: 'deploy' })
    } catch (e) {
      // Another worker on the same local network may have deployed it first.
      if (!(await this.#exists(sac.id))) throw e
    }
    return sac
  }

  async #exists(contractId: string): Promise<boolean> {
    try {
      await this.rpc.getContractInstance(contractId)
      return true
    } catch {
      return false
    }
  }

  /** The latest closed ledger: its sequence number and close time (Unix seconds). */
  async latestLedger(): Promise<{ sequence: number; closeTime: number }> {
    // Read raw: the SDK's parser can lag the network's newest header format.
    const res = await rpcCall<{ sequence: number; closeTime?: string | number }>(this.rpcUrl, 'getLatestLedger')
    return { sequence: res.sequence, closeTime: Number(res.closeTime ?? 0) }
  }

  /** Closes `ledgers` empty ledgers; contract TTLs count down with them. soroban-sim only. */
  async advanceLedgers(ledgers: number): Promise<NextLedger> {
    const res = await this[ADMIN]<{ next: NextLedger }>('advanceLedgers', 'fork_advanceLedgers', { ledgers })
    return res.next
  }

  /** Moves the clock forward so the next ledger closes at `time` (a Date or Unix seconds). soroban-sim only. */
  async setTime(time: Date | number): Promise<NextLedger> {
    const seconds = time instanceof Date ? Math.floor(time.getTime() / 1000) : time
    const res = await this[ADMIN]<{ next: NextLedger }>('setTime', 'fork_setTime', { time: seconds })
    return res.next
  }

  /** Stops the worker's soroban-sim server (nothing to stop on a local network). */
  tearDown(): Promise<void> {
    return this.#backend.stop()
  }

  /** A soroban-sim admin method; a local network refuses it. */
  async [ADMIN]<T = unknown>(capability: string, method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.sandbox) throw new SandboxOnlyError(capability)
    return rpcCall<T>(this.rpcUrl, method, params)
  }

  /** Accounts that already exist in the state the worker started from (a suite's setup). */
  [ADOPT](names: readonly string[]): void {
    for (const name of names) {
      if (!this.#accounts.has(name)) this.#accounts.set(name, new Account(this, name, deriveKeypair(this.#seed, name)))
    }
  }

  [ACCOUNTS](): string[] {
    return [...this.#accounts.keys()]
  }
}

async function simBackend(config: Config, snapshot: string): Promise<Backend> {
  const srv = await startServer(config.sim.bin, ['--snapshot', snapshot])
  return {
    url: srv.url,
    async fund(address) {
      await rpcCall(srv.url, 'fork_setBalance', { account: address, xlm: FUNDING_XLM, label: 'account' })
    },
    stop: () => srv.stop(),
  }
}

function localBackend(config: Config): Backend {
  const { rpcUrl, friendbotUrl } = config.local
  return { url: rpcUrl, fund: (address) => friendbot(friendbotUrl, address), stop: async () => {} }
}

async function friendbot(url: string, account: string): Promise<void> {
  let last = ''
  for (let i = 0, delay = 250; i < 8; i++, delay *= 2) {
    try {
      const res = await fetch(`${url}?addr=${encodeURIComponent(account)}`)
      if (res.ok) return
      last = `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`
      if (res.status < 500 && res.status !== 429) break
    } catch (e) {
      last = `${(e as Error).message}; is a local network running? (stellar container start local)`
    }
    await new Promise((r) => setTimeout(r, delay))
  }
  throw new Error(`friendbot ${url} could not fund ${account}: ${last}`)
}

