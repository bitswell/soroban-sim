import { contract, xdr } from '@stellar/stellar-sdk'

// A Stellar asset contract has no Wasm and so no spec to read. These are
// its functions (the SEP-41 token interface and the admin's), with the
// host's error codes, so calls to it take and return native values like any
// other contract's.

const T = xdr.ScSpecTypeDef
const types = {
  address: () => T.scSpecTypeAddress(),
  bool: () => T.scSpecTypeBool(),
  i128: () => T.scSpecTypeI128(),
  u32: () => T.scSpecTypeU32(),
  string: () => T.scSpecTypeString(),
}
type TypeName = keyof typeof types

function fn(name: string, inputs: [string, TypeName][], output?: TypeName): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: '',
      name,
      inputs: inputs.map(([n, t]) => new xdr.ScSpecFunctionInputV0({ doc: '', name: n, type: types[t]() })),
      outputs: output ? [types[output]()] : [],
    }),
  )
}

/** The host's errors for its built-in contracts. */
const ERRORS: [string, number][] = [
  ['InternalError', 1],
  ['OperationNotSupportedError', 2],
  ['AlreadyInitializedError', 3],
  ['UnauthorizedError', 4],
  ['AuthenticationError', 5],
  ['AccountMissingError', 6],
  ['AccountIsNotClassic', 7],
  ['NegativeAmountError', 8],
  ['AllowanceError', 9],
  ['BalanceError', 10],
  ['BalanceDeauthorizedError', 11],
  ['OverflowError', 12],
  ['TrustlineMissingError', 13],
]

export const STELLAR_ASSET_SPEC = new contract.Spec([
  fn('allowance', [['from', 'address'], ['spender', 'address']], 'i128'),
  fn('approve', [['from', 'address'], ['spender', 'address'], ['amount', 'i128'], ['expiration_ledger', 'u32']]),
  fn('balance', [['id', 'address']], 'i128'),
  fn('transfer', [['from', 'address'], ['to', 'address'], ['amount', 'i128']]),
  fn('transfer_from', [['spender', 'address'], ['from', 'address'], ['to', 'address'], ['amount', 'i128']]),
  fn('burn', [['from', 'address'], ['amount', 'i128']]),
  fn('burn_from', [['spender', 'address'], ['from', 'address'], ['amount', 'i128']]),
  fn('decimals', [], 'u32'),
  fn('name', [], 'string'),
  fn('symbol', [], 'string'),
  fn('mint', [['to', 'address'], ['amount', 'i128']]),
  fn('clawback', [['from', 'address'], ['amount', 'i128']]),
  fn('set_admin', [['new_admin', 'address']]),
  fn('admin', [], 'address'),
  fn('set_authorized', [['id', 'address'], ['authorize', 'bool']]),
  fn('authorized', [['id', 'address']], 'bool'),
  xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
    new xdr.ScSpecUdtErrorEnumV0({
      doc: '',
      lib: '',
      name: 'Error',
      cases: ERRORS.map(([name, value]) => new xdr.ScSpecUdtErrorEnumCaseV0({ doc: '', name, value })),
    }),
  ),
])
