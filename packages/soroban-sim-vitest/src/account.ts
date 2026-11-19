import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Address, Operation, scValToNative, type Keypair, type rpc } from '@stellar/stellar-sdk'
import { Contract, fromScVal, rememberSpec, toScVals, type Args } from './contract.ts'
import { ADMIN, DEPLOYS, MARKER } from './internal.ts'
import { send } from './transactions.ts'
import { toPath } from './paths.ts'
import type { Worker } from './worker.ts'

/** What a call returned, with the transaction it was sent in. */
export interface CallResult<T> {
  value: T
  hash: string
  /** The ledger the transaction applied in, and that ledger's close time (Unix seconds). */
  ledger: number
  closeTime: number
  response: rpc.Api.GetSuccessfulTransactionResponse
}

export interface DeployOptions {
  /** The constructor's arguments, named (converted with the contract's spec) or as xdr.ScVal[]. */
  args?: Args
  /** 32 bytes; the default is random, so each deploy is a new contract. */
  salt?: Uint8Array
}

/** A funded account, created by name. It signs and pays for whatever it sends. */
export class Account {
  readonly worker: Worker
  /** The name the account was created with. */
  readonly name: string
  /** Its throwaway keypair, for building transactions by hand. */
  readonly keypair: Keypair

  constructor(worker: Worker, name: string, keypair: Keypair) {
    this.worker = worker
    this.name = name
    this.keypair = keypair
  }

  /** `G…` */
  get address(): string {
    return this.keypair.publicKey()
  }

  /**
   * Calls `method` in a transaction this account signs and sends, and
   * returns the result as a native value. A failure throws an
   * InvocationError; a contract's own error is a ContractError with its code.
   */
  async call<T = any>(contract: Contract | string, method: string, args?: Args): Promise<T> {
    return (await this.callRaw<T>(contract, method, args)).value
  }

  /** As `call`, with the transaction's hash, ledger and full response. */
  async callRaw<T = any>(contract: Contract | string, method: string, args?: Args): Promise<CallResult<T>> {
    const target = typeof contract === 'string' ? this.worker.contract(contract) : contract
    const spec = await target.spec()
    const op = Operation.invokeContractFunction({ contract: target.id, function: method, args: toScVals(target, spec, method, args) })
    const res = await send(this.worker, this.keypair, op, { contract: target.id, method, spec })
    return {
      value: fromScVal(spec, method, res.returnValue) as T,
      hash: res.txHash,
      ledger: res.ledger,
      closeTime: Number(res.createdAt),
      response: res,
    }
  }

  /** Uploads `wasm` (a path, URL or bytes), creates a contract from it with this account as deployer, and returns it. */
  async deploy(wasm: string | URL | Uint8Array, options: DeployOptions = {}): Promise<Contract> {
    const code = wasm instanceof Uint8Array ? wasm : await readFile(toPath(wasm))
    const hash = createHash('sha256').update(code).digest('hex')
    const allowed = this.worker[DEPLOYS]
    if (allowed && !allowed.has(hash)) {
      const what = wasm instanceof Uint8Array ? `Wasm ${hash.slice(0, 12)}…` : String(wasm)
      throw new Error(`setup deploys ${what}, which the suite does not list in \`wasm\`: list it so the setup cache key covers it`)
    }
    rememberSpec(hash, code)
    const upload = { contract: 'the network', method: 'uploadContractWasm' }
    await send(this.worker, this.keypair, Operation.uploadContractWasm({ wasm: Buffer.from(code) }), upload)
    const pending = new Contract(this.worker, 'a new contract', hash)
    const spec = await pending.spec()
    const hasConstructor = spec?.funcs().some((f) => f.name.toString() === '__constructor')
    const constructorArgs =
      options.args === undefined && !hasConstructor ? [] : toScVals(pending, spec, '__constructor', options.args)
    const op = Operation.createCustomContract({
      address: Address.fromString(this.address),
      wasmHash: Buffer.from(hash, 'hex'),
      salt: Buffer.from(options.salt ?? randomBytes(32)),
      constructorArgs,
    })
    const res = await send(this.worker, this.keypair, op, { contract: 'a new contract', method: '__constructor', spec })
    return new Contract(this.worker, scValToNative(res.returnValue!) as string, hash)
  }

  /** The account's XLM balance in stroops. */
  async balance(): Promise<bigint> {
    const entry = await this.worker.rpc.getAccountEntry(this.address)
    return BigInt(String(entry.balance))
  }

  /** Sets the account's XLM balance, in stroops. soroban-sim only. */
  async setBalance(stroops: bigint): Promise<void> {
    await this.worker[ADMIN]('setBalance', 'fork_setBalance', { account: this.address, stroops: stroops.toString(), label: this.name })
  }

  /** Stored in a setup's result as a marker; a test gets the account back on its own network. */
  toJSON(): unknown {
    return { [MARKER]: 'account', name: this.name }
  }

  toString(): string {
    return this.address
  }
}
