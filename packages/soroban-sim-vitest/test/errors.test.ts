// Which contract a ContractError's name comes from. The events are built in
// the shape the host logs them, so these run without a network.
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { expect, test } from 'vitest'
import { ContractError } from '../src/index.ts'
import { invocationError } from '../src/errors.ts'
import { STELLAR_ASSET_SPEC } from '../src/sac.ts'

const VAULT = 'CA7742EZELDVK5IFOELP7EBOYSFZFU5RO7S5MX4RVUJCYT7U3ZYGMUSV'
const TOKEN = 'CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYKH4GCESXYHS3IHQ4EIG4'

const symbol = (s: string) => xdr.ScVal.scvSymbol(s)
const balanceError = xdr.ScVal.scvError(xdr.ScError.sceContract(10))

/** A diagnostic event logged while `contract` runs (null: outside any contract). */
function logged(contract: string | null, topics: xdr.ScVal[]): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: contract ? new xdr.ContractId(Address.fromString(contract).toBuffer()) : null,
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics, data: xdr.ScVal.scvVoid() })),
    }),
  })
}

const callTo = (from: string | null, to: string, fn: string) =>
  logged(from, [symbol('fn_call'), nativeToScVal(Address.fromString(to).toBuffer()), symbol(fn)])
const returnFrom = (contract: string, fn: string) => logged(contract, [symbol('fn_return'), symbol(fn)])
const errorIn = (contract: string) => logged(contract, [symbol('error'), balanceError])

// The vault's own enum names code 10 here; the token's names it BalanceError.
const vault = { contract: VAULT, method: 'withdraw', spec: STELLAR_ASSET_SPEC }
const HOST_TEXT = 'HostError: Error(Contract, #10)'

const tokenFailed = [callTo(null, VAULT, 'withdraw'), callTo(VAULT, TOKEN, 'transfer'), errorIn(TOKEN), errorIn(VAULT)]
const vaultFailed = [callTo(null, VAULT, 'withdraw'), callTo(VAULT, TOKEN, 'balance'), returnFrom(TOKEN, 'balance'), errorIn(VAULT)]

test.for([
  ['simulation', HOST_TEXT],
  ['on the ledger', ''],
])('%s: an error raised by a contract the call reached is not named from the called contract', ([, text]) => {
  const error = invocationError(vault, text, tokenFailed)
  expect(error).toBeInstanceOf(ContractError)
  expect(error).toMatchObject({ code: 10, errorName: undefined, hostError: 'Error(Contract, #10)' })
})

test.for([
  ['simulation', HOST_TEXT],
  ['on the ledger', ''],
])('%s: the called contract’s own error is named, also after calls of its own that returned', ([, text]) => {
  const error = invocationError(vault, text, vaultFailed)
  expect(error).toMatchObject({ code: 10, errorName: 'BalanceError', hostError: 'Error(Contract, #10) BalanceError' })
})
