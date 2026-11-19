import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Address, Operation, StrKey, contract, hash, xdr, type Keypair } from '@stellar/stellar-sdk'
import {
  boundOf,
  buildClient,
  clientOptions,
  isDefinition,
  mapSignAndSend,
  mapping,
  rememberSpec,
  specFor,
  wasmHashOf,
  type BindingsClass,
  type ContractClient,
  type ContractDefinition,
} from './clients.ts'
import { ADMIN, BINDINGS, DEPLOYS, MARKER } from './internal.ts'
import { toPath } from './paths.ts'
import type { Worker } from './worker.ts'

export interface DeployOptions<B extends BindingsClass | undefined = undefined> {
  /** The constructor's arguments, named, as the contract's spec declares them. */
  args?: Record<string, unknown>
  /** 32 bytes; the default is random, so each deploy is a new contract. */
  salt?: Uint8Array
  /** The generated bindings `Client` to return, for typed methods. */
  client?: B
}

type Deployed<B> = B extends BindingsClass<infer C> ? C : ContractClient

/** A funded account, created by name. It signs and pays for the transactions of the clients bound to it. */
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

  /** The account as an SDK signer: `signTransaction` and `signAuthEntry` (`contract.basicNodeSigner`). */
  get signer(): ReturnType<typeof contract.basicNodeSigner> {
    return contract.basicNodeSigner(this.keypair, this.worker.networkPassphrase)
  }

  /**
   * The same contract with this account signing: an SDK client of the same
   * class (the generated one, or `contract.Client`), on this account's
   * network. Given a bindings class, a client of that class.
   */
  client<C extends contract.Client>(contract: C): C
  client<C extends contract.Client>(contract: contract.Client, Bindings: BindingsClass<C>): C
  client(contract: contract.Client, Bindings?: BindingsClass): contract.Client {
    const bound = boundOf(contract)
    if (!bound) throw new Error('account.client takes a client from this package (deploy, worker.contract or worker.xlm)')
    if (bound.worker !== this.worker) throw new Error(`that client is on another worker's network than ${this.name}`)
    return buildClient(this.worker, contract.options.contractId, contract.spec, bound.wasmHash, this, Bindings ?? bound.Bindings)
  }

  /**
   * Uploads the contract's Wasm, creates a contract from it with `args` for
   * its constructor, and returns a client for it with this account signing.
   * Given a `defineContract` declaration, a client of its generated class,
   * typed; given a path, URL or bytes, the generated class in `client`, or
   * the spec-built `contract.Client`.
   */
  deploy<C extends contract.Client>(contract: ContractDefinition<C>, options?: Omit<DeployOptions, 'client'>): Promise<C>
  deploy<B extends BindingsClass | undefined = undefined>(wasm: string | URL | Uint8Array, options?: DeployOptions<B>): Promise<Deployed<B>>
  async deploy(
    what: string | URL | Uint8Array | ContractDefinition<contract.Client>,
    given: DeployOptions<BindingsClass | undefined> = {},
  ): Promise<contract.Client> {
    const wasm = isDefinition(what) ? what.file : what
    const options = isDefinition(what) ? { ...given, client: what.client } : given
    const code = wasm instanceof Uint8Array ? wasm : await readFile(toPath(wasm))
    const wasmHash = createHash('sha256').update(code).digest('hex')
    const allowed = this.worker[DEPLOYS]
    if (allowed && !allowed.has(wasmHash)) {
      const what = wasm instanceof Uint8Array ? `Wasm ${wasmHash.slice(0, 12)}…` : String(wasm)
      throw new Error(`setup deploys ${what}, which the suite does not list in \`wasm\`: list it so the setup cache key covers it`)
    }
    const paired = this.worker[BINDINGS].get(wasmHash)
    if (allowed && options.client && options.client !== paired) {
      throw new Error(
        `setup deploys ${String(wasm)} with a bindings client the suite does not pair with it: ` +
          'list it in `wasm` as { file, client } so every test gets that client back',
      )
    }
    rememberSpec(wasmHash, code)
    const salt = options.salt ?? randomBytes(32)
    const id = contractId(this.worker.networkPassphrase, this.address, salt)
    const signed = clientOptions(this.worker, id, this)

    // Code already on the ledger (uploaded by setup, say) is not uploaded again:
    // the SDK takes that upload's simulation for a read and will not send it.
    if (!(await this.worker.rpc.getContractWasmByHash(wasmHash, 'hex').then(() => true, () => false))) {
      const upload = await contract.AssembledTransaction.buildWithOp(Operation.uploadContractWasm({ wasm: Buffer.from(code) }), {
        ...signed,
        method: 'uploadContractWasm',
        parseResultXdr: (result: xdr.ScVal) => result,
      })
      const uploadTarget = { contract: 'the network', method: 'uploadContractWasm' }
      mapSignAndSend(upload, uploadTarget, this.worker)
      if (!(await mapping(uploadTarget, upload, async () => upload.isReadCall))) await upload.signAndSend()
    }

    const spec = await specFor(this.worker, wasmHash)
    const { contractId: _id, ...deployOptions } = signed
    const created = (await contract.Client.deploy(options.args ?? null, {
      ...deployOptions,
      wasmHash,
      salt: Buffer.from(salt),
    })) as contract.AssembledTransaction<unknown>
    const target = { contract: id, method: '__constructor', spec }
    mapSignAndSend(created, target, this.worker)
    await created.signAndSend()
    return buildClient(this.worker, id, spec, wasmHash, this, options.client ?? paired)
  }

  /**
   * Signs this account's authorization entries in `tx`, a transaction
   * another account sends (`tx.needsNonInvokerSigningBy()` lists who must):
   * the SDK's `signAuthEntries`, valid for the next 100 ledgers.
   */
  async signAuthEntries(tx: contract.AssembledTransaction<unknown>): Promise<void> {
    // The SDK reads the latest ledger itself when no expiration is given, and
    // its parser can lag the network's newest header format.
    const { sequence } = await this.worker.latestLedger()
    await tx.signAuthEntries({ address: this.address, signAuthEntry: this.signer.signAuthEntry, expiration: sequence + 100 })
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

/** An unsigned client for the contract at `id` (reads only), of the bindings class when given. */
export async function attach(
  worker: Worker,
  id: string,
  Bindings?: BindingsClass,
  signer?: Account,
  knownHash?: string | null,
): Promise<ContractClient> {
  const wasmHash = knownHash === undefined ? await wasmHashOf(worker, id) : (knownHash ?? undefined)
  const spec = await specFor(worker, wasmHash)
  const paired = wasmHash ? worker[BINDINGS].get(wasmHash) : undefined
  return buildClient(worker, id, spec, wasmHash, signer, Bindings ?? paired)
}

/** The address of the contract `deployer` creates with `salt`. */
function contractId(networkPassphrase: string, deployer: string, salt: Uint8Array): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer).toScAddress(), salt: Buffer.from(salt) }),
      ),
    }),
  )
  return StrKey.encodeContract(hash(Buffer.from(preimage.toXdr())))
}
