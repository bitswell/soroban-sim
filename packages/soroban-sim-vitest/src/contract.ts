import { Address, Operation, contract, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk'
import { ADMIN, MARKER } from './internal.ts'
import { STELLAR_ASSET_SPEC } from './sac.ts'
import { rpcCall } from './server.ts'
import { simulate } from './transactions.ts'
import type { Worker } from './worker.ts'

/**
 * A call's arguments: named native values converted with the contract's spec
 * (`{ to: bob, amount: 10n }`; accounts and contracts stand for their
 * addresses), or the XDR values themselves.
 */
export type Args = Record<string, unknown> | readonly xdr.ScVal[]

/** Contract storage that can be read and patched: instance storage lives in the contract's own entry. */
export type Durability = 'persistent' | 'temporary'

export interface StorageOptions {
  durability?: Durability
  /** How to convert a native key, as `nativeToScVal`'s `type` (`'u32'`, `'symbol'`…); ignored for an xdr.ScVal. */
  keyType?: string
  /** How to convert a native value, as above. */
  valueType?: string
}

/** Specs by Wasm hash, shared across workers: a hash names the same code everywhere. */
const specs = new Map<string, Promise<contract.Spec | null>>()

export function rememberSpec(wasmHash: string, wasm: Uint8Array): void {
  if (!specs.has(wasmHash)) specs.set(wasmHash, Promise.resolve(specFromWasm(wasm)))
}

function specFromWasm(wasm: Uint8Array): contract.Spec | null {
  try {
    return contract.Spec.fromWasm(Buffer.from(wasm))
  } catch {
    return null
  }
}

/** A contract on the worker's network. Calls that change state go through an account: `account.call(contract, …)`. */
export class Contract {
  readonly worker: Worker
  /** The contract's address, `C…`. */
  readonly id: string
  #wasmHash: string | undefined
  #spec: Promise<contract.Spec | null> | undefined

  constructor(worker: Worker, id: string, wasmHash?: string) {
    this.worker = worker
    this.id = id
    this.#wasmHash = wasmHash
  }

  get address(): string {
    return this.id
  }

  /** The contract's spec (from its Wasm, or the token interface for a Stellar asset contract); null if it has none. */
  spec(): Promise<contract.Spec | null> {
    this.#spec ??= this.#loadSpec().catch((e) => {
      this.#spec = undefined
      throw e
    })
    return this.#spec
  }

  async #loadSpec(): Promise<contract.Spec | null> {
    if (!this.#wasmHash) {
      const { executable } = await this.worker.rpc.getContractInstance(this.id)
      if (executable.type !== 'contractExecutableWasm') return STELLAR_ASSET_SPEC
      this.#wasmHash = Buffer.from(executable.wasmHash.value).toString('hex')
    }
    const hash = this.#wasmHash
    let found = specs.get(hash)
    if (!found) {
      found = this.worker.rpc.getContractWasmByHash(hash, 'hex').then(specFromWasm)
      specs.set(hash, found)
      found.catch(() => specs.delete(hash))
    }
    return found
  }

  /** Simulates a call and returns its result as a native value; nothing is signed or sent. */
  async view<T = any>(method: string, args?: Args): Promise<T> {
    const spec = await this.spec()
    const op = Operation.invokeContractFunction({ contract: this.id, function: method, args: toScVals(this, spec, method, args) })
    return fromScVal(spec, method, await simulate(this.worker, op, { contract: this.id, method, spec })) as T
  }

  /** Reads one entry of the contract's persistent (default) or temporary storage; undefined when absent. */
  async getStorage<T = any>(key: unknown, options: StorageOptions = {}): Promise<T | undefined> {
    const res = await this.worker.rpc.getLedgerEntries(this.#dataKey(key, options))
    const entry = res.entries[0]
    if (!entry || entry.val.type !== 'contractData') return undefined
    return scValToNative(entry.val.contractData.val) as T
  }

  /** Sets one storage entry, keeping its TTL (or, for a new entry, live for a long while). soroban-sim only. */
  async setStorage(key: unknown, value: unknown, options: StorageOptions = {}): Promise<void> {
    const ledgerKey = this.#dataKey(key, options)
    const [current, latest] = await Promise.all([
      this.worker.rpc.getLedgerEntries(ledgerKey),
      rpcCall<{ sequence: number }>(this.worker.rpcUrl, 'getLatestLedger'),
    ])
    const liveUntil = current.entries[0]?.liveUntilLedgerSeq ?? latest.sequence + NEW_ENTRY_TTL
    const entry = new xdr.LedgerEntry({
      lastModifiedLedgerSeq: latest.sequence,
      data: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: xdr.ExtensionPoint.v0(),
          contract: new Address(this.id).toScAddress(),
          key: scVal(key, options.keyType),
          durability: durabilityOf(options),
          val: scVal(value, options.valueType),
        }),
      ),
      ext: xdr.LedgerEntryExt.v0(),
    })
    await this.worker[ADMIN]('setStorage', 'fork_setLedgerEntry', {
      entry: entry.toXdr('base64'),
      liveUntilLedgerSeq: liveUntil,
      label: `${this.id} storage`,
    })
  }

  /** Removes one storage entry. soroban-sim only. */
  async removeStorage(key: unknown, options: StorageOptions = {}): Promise<void> {
    await this.worker[ADMIN]('removeStorage', 'fork_removeLedgerEntry', {
      key: this.#dataKey(key, options).toXdr('base64'),
      label: `${this.id} storage`,
    })
  }

  #dataKey(key: unknown, options: StorageOptions): xdr.LedgerKey {
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(this.id).toScAddress(),
        key: scVal(key, options.keyType),
        durability: durabilityOf(options),
      }),
    )
  }

  /** Stored in a setup's result as a marker; a test gets the contract back on its own network. */
  toJSON(): unknown {
    return { [MARKER]: 'contract', id: this.id, wasmHash: this.#wasmHash ?? null }
  }

  toString(): string {
    return this.id
  }
}

/** A new storage entry's TTL in ledgers: about a week of five-second ledgers. */
const NEW_ENTRY_TTL = 120_000

function durabilityOf(options: StorageOptions): xdr.ContractDataDurability {
  return options.durability === 'temporary' ? xdr.ContractDataDurability.temporary : xdr.ContractDataDurability.persistent
}

function scVal(value: unknown, type: string | undefined): xdr.ScVal {
  if (xdr.ScVal.is(value)) return value
  return nativeToScVal(addresses(value), type ? ({ type } as Parameters<typeof nativeToScVal>[1]) : undefined)
}

/** Accounts and contracts inside arguments become their addresses. */
function addresses(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (xdr.ScVal.is(value) || value instanceof Uint8Array || value instanceof Address) return value
  if ('address' in value && typeof value.address === 'string' && (value as { worker?: unknown }).worker) {
    return Address.fromString(value.address)
  }
  if (Array.isArray(value)) return value.map(addresses)
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [addresses(k), addresses(v)]))
  if (Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, addresses(v)]))
}

export function toScVals(target: Contract, spec: contract.Spec | null, method: string, args: Args | undefined): xdr.ScVal[] {
  if (Array.isArray(args)) return [...args] as xdr.ScVal[]
  if (!spec) {
    if (args === undefined) return []
    throw new Error(
      `${target.id} has no contract spec to convert named arguments with; pass the arguments as xdr.ScVal[]`,
    )
  }
  let fn: xdr.ScSpecFunctionV0
  try {
    fn = spec.getFunc(method)
  } catch {
    const known = spec.funcs().map((f) => f.name.toString())
    throw new Error(`${target.id} has no function ${JSON.stringify(method)}; it has ${known.join(', ') || 'none'}`)
  }
  if (args === undefined && fn.inputs.length === 0) return []
  return spec.funcArgsToScVals(method, (addresses(args ?? {}) ?? {}) as object)
}

export function fromScVal(spec: contract.Spec | null, method: string, value: xdr.ScVal | undefined): unknown {
  if (!value) return undefined
  if (!spec?.funcs().some((f) => f.name.toString() === method)) return scValToNative(value)
  const native = spec.funcResToNative(method, value)
  return native instanceof contract.Ok ? native.unwrap() : native
}
