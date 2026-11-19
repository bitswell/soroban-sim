// The Stellar asset contract has no Wasm to read a spec from: the spec entries
// the harness uses are checked here against the generated bindings' own.
import { expect, test } from 'vitest'
import { Client as Generated } from '../src/generated/stellar-asset.ts'
import { STELLAR_ASSET_ENTRIES, STELLAR_ASSET_SPEC } from '../src/sac.ts'

test('the spec entries are the ones stellar contract bindings generated', () => {
  const generated = new Generated({
    contractId: 'CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYKH4GCESXYHS3IHQ4EIG4',
    networkPassphrase: 'Standalone Network ; February 2017',
    rpcUrl: 'http://127.0.0.1:1',
    allowHttp: true,
  })
  expect(generated.spec.entries.map((entry) => entry.toXdr('base64'))).toEqual([...STELLAR_ASSET_ENTRIES])
  expect(STELLAR_ASSET_SPEC.funcs().map((f) => f.name.toString())).toContain('trust')
})
