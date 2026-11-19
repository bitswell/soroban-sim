// Which contract a ContractError's name comes from. The events are built in
// the shape the host logs them, so these run without a network.
import { Address, xdr } from '@stellar/stellar-sdk'
import { expect, test } from 'vitest'
import { ContractError } from '../src/index.ts'
import { invocationError } from '../src/errors.ts'
import { STELLAR_ASSET_SPEC } from '../src/sac.ts'

const VAULT = 'CA7742EZELDVK5IFOELP7EBOYSFZFU5RO7S5MX4RVUJCYT7U3ZYGMUSV'
const TOKEN = 'CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYKH4GCESXYHS3IHQ4EIG4'

/** A diagnostic `error` event for contract error `code`, logged while `contract` runs. */
function errorIn(contract: string, code: number): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: new xdr.ContractId(Address.fromString(contract).toBuffer()),
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol('error'), xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
          data: xdr.ScVal.scvVoid(),
        }),
      ),
    }),
  })
}

// The vault's own enum names code 10 here; the token's names it BalanceError.
const vault = { contract: VAULT, method: 'withdraw', spec: STELLAR_ASSET_SPEC }
const paths: [string, string][] = [
  ['simulation', 'HostError: Error(Contract, #10)'],
  ['on the ledger', ''],
]

// The token raises 10; the vault logs it twice more as its call fails and its VM traps.
const tokenFailed = [errorIn(TOKEN, 10), errorIn(VAULT, 10), errorIn(VAULT, 10)]
const vaultFailed = [errorIn(VAULT, 10)]
// The token raises 9, the vault catches it (try_call) and then raises its own 10.
const vaultFailedAfterCatching = [errorIn(TOKEN, 9), errorIn(VAULT, 9), errorIn(VAULT, 10)]

test.for(paths)('%s: an error raised by a contract the call reached is not named from the called contract', ([, text]) => {
  const error = invocationError(vault, text, tokenFailed)
  expect(error).toBeInstanceOf(ContractError)
  expect(error).toMatchObject({ code: 10, errorName: undefined, hostError: 'Error(Contract, #10)' })
})

test.for(paths)('%s: the called contract’s own error is named', ([, text]) => {
  const error = invocationError(vault, text, vaultFailed)
  expect(error).toMatchObject({ code: 10, errorName: 'BalanceError', hostError: 'Error(Contract, #10) BalanceError' })
})

test.for(paths)('%s: the called contract’s own error is named after it caught a failed call', ([, text]) => {
  const error = invocationError(vault, text, vaultFailedAfterCatching)
  expect(error).toMatchObject({ code: 10, errorName: 'BalanceError', hostError: 'Error(Contract, #10) BalanceError' })
})
