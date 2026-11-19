import { Account as SourceAccount, BASE_FEE, Keypair, TimeoutInfinite, TransactionBuilder, rpc, type xdr } from '@stellar/stellar-sdk'
import { TransactionError, invocationError, type CallTarget } from './errors.ts'

/** What sending and simulating need: the RPC client and the network's passphrase. */
export interface Network {
  rpc: rpc.Server
  networkPassphrase: string
}

/**
 * Builds, simulates, signs and sends one Soroban operation from `source`,
 * then waits for its result. A refused simulation or a failed call throws
 * an InvocationError (a ContractError for the contract's own errors).
 * soroban-sim applies the transaction inside `sendTransaction`; a local
 * network within a ledger or two. The transaction has no upper time bound:
 * a test that moves ledger time ahead (setTime) would otherwise find a bound
 * set from the wall clock already passed.
 */
export async function send(
  net: Network,
  source: Keypair,
  operation: xdr.Operation,
  target: CallTarget,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const account = await net.rpc.getAccount(source.publicKey())
  const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.networkPassphrase })
    .addOperation(operation)
    .setTimeout(TimeoutInfinite)
    .build()
  const sim = await net.rpc.simulateTransaction(built)
  if (rpc.Api.isSimulationError(sim)) throw invocationError(target, sim.error, sim.events)
  const tx = rpc.assembleTransaction(built, sim).build()
  tx.sign(source)
  const sent = await net.rpc.sendTransaction(tx)
  const what = `${target.method} on ${target.contract}`
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    throw new TransactionError(what, sent.status, sent.errorResult?.result.type)
  }
  const result = await waitFor(net, sent.hash)
  if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
    const events = result.diagnosticEventsXdr ?? []
    const code = result.resultXdr.result.type
    if (events.length) throw invocationError(target, '', events)
    throw new TransactionError(what, 'FAILED', code)
  }
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new TransactionError(what, result.status, undefined)
  return result
}

async function waitFor(net: Network, hash: string, timeoutMs = 60_000): Promise<rpc.Api.GetTransactionResponse> {
  const deadline = Date.now() + timeoutMs
  for (let delay = 20; ; delay = Math.min(delay * 2, 500)) {
    const res = await net.rpc.getTransaction(hash)
    if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return res
    if (Date.now() > deadline) throw new TransactionError(`transaction ${hash}`, 'NOT_FOUND', `after ${timeoutMs} ms`)
    await new Promise((r) => setTimeout(r, delay))
  }
}

/** A source for read-only simulations: it never signs, so it need not exist. */
const VIEWER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey()

/** Simulates one operation without sending it and returns its return value. */
export async function simulate(net: Network, operation: xdr.Operation, target: CallTarget): Promise<xdr.ScVal | undefined> {
  const tx = new TransactionBuilder(new SourceAccount(VIEWER, '0'), { fee: BASE_FEE, networkPassphrase: net.networkPassphrase })
    .addOperation(operation)
    .setTimeout(TimeoutInfinite)
    .build()
  const sim = await net.rpc.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw invocationError(target, sim.error, sim.events)
  return (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval
}
