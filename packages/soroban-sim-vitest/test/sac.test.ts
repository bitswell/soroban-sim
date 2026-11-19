// The Stellar asset contract has no Wasm to read a spec from: its spec and
// error names are checked here against their sources.
import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { Client as Generated } from '../src/generated/stellar-asset.ts'
import { STELLAR_ASSET_ENTRIES, STELLAR_ASSET_ERRORS, STELLAR_ASSET_SPEC } from '../src/sac.ts'

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

test('the error names are the host’s, by code', async () => {
  const source = await readFile(new URL('../../../crates/soroban-sim-host/src/builtin_contracts/contract_error.rs', import.meta.url), 'utf8')
  const body = /pub\(crate\) enum ContractError \{([\s\S]*?)\n\}/.exec(source)![1]
  const host = [...body.matchAll(/^\s*([A-Za-z]\w*) = (\d+),/gm)].map(([, name, code]) => [name, Number(code)])
  expect([...STELLAR_ASSET_ERRORS]).toEqual(host.filter(([name]) => !String(name).startsWith('_')))
})
