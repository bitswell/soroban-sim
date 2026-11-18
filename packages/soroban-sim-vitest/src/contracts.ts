import { randomBytes } from 'node:crypto'
import {
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

/** What the helpers need from a setup context or a test environment. */
export interface Network {
  rpc: rpc.Server
  networkPassphrase: string
}

/**
 * Builds, simulates, signs and sends one Soroban operation, then waits for
 * its result. The same code runs on both environments: soroban-sim applies
 * the transaction inside `sendTransaction`, a local network within a ledger
 * or two.
 */
export async function submit(
  net: Network,
  source: Keypair,
  operation: xdr.Operation,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const account = await net.rpc.getAccount(source.publicKey())
  const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.networkPassphrase })
    .addOperation(operation)
    .setTimeout(300)
    .build()
  const tx = await net.rpc.prepareTransaction(built)
  tx.sign(source)
  const sent = await net.rpc.sendTransaction(tx)
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    const code = sent.errorResult?.result.type
    throw new Error(`sendTransaction: ${sent.status}${code ? ` (${code})` : ''}`)
  }
  const result = await waitFor(net, sent.hash)
  if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(`transaction ${sent.hash} FAILED (${result.resultXdr.result.type})`)
  }
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${sent.hash} ${result.status}`)
  return result
}

async function waitFor(net: Network, hash: string, timeoutMs = 60_000): Promise<rpc.Api.GetTransactionResponse> {
  const deadline = Date.now() + timeoutMs
  for (let delay = 20; ; delay = Math.min(delay * 2, 500)) {
    const res = await net.rpc.getTransaction(hash)
    if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return res
    if (Date.now() > deadline) throw new Error(`transaction ${hash} not found after ${timeoutMs} ms`)
    await new Promise((r) => setTimeout(r, delay))
  }
}

/** Uploads Wasm (once per code hash on the ledger) and returns its hash. */
export async function uploadWasm(net: Network, source: Keypair, wasm: Uint8Array): Promise<Buffer> {
  const res = await submit(net, source, Operation.uploadContractWasm({ wasm: Buffer.from(wasm) }))
  return scValToNative(res.returnValue!) as Buffer
}

/** Uploads `wasm` and creates a contract from it; returns the contract's `C…` address. */
export async function deployContract(
  net: Network,
  source: Keypair,
  wasm: Uint8Array,
  options: { constructorArgs?: xdr.ScVal[]; salt?: Buffer } = {},
): Promise<string> {
  const wasmHash = await uploadWasm(net, source, wasm)
  const res = await submit(
    net,
    source,
    Operation.createCustomContract({
      address: Address.fromString(source.publicKey()),
      wasmHash,
      salt: options.salt ?? randomBytes(32),
      constructorArgs: options.constructorArgs,
    }),
  )
  return scValToNative(res.returnValue!) as string
}

/** Calls a contract function in a signed transaction and returns its result as a native value. */
export async function invoke(
  net: Network,
  source: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const res = await submit(net, source, Operation.invokeContractFunction({ contract: contractId, function: method, args }))
  return res.returnValue ? scValToNative(res.returnValue) : undefined
}

/**
 * Simulates a contract call without sending it and returns its result as a
 * native value: for reads. `source` must be an existing account.
 */
export async function read(
  net: Network,
  source: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const account = await net.rpc.getAccount(source.publicKey())
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.networkPassphrase })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: method, args }))
    .setTimeout(300)
    .build()
  const sim = await net.rpc.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulate ${method}: ${sim.error}`)
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval
  return retval ? scValToNative(retval) : undefined
}
