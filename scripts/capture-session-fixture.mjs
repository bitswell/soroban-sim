#!/usr/bin/env node
/**
 * capture-session-fixture.mjs — record what forking a network over RPC reads
 * at the start of a browser session, so the web demo's session tests replay a
 * real testnet fork offline (Playwright answers the RPC from the recording).
 *
 * Read-only: getNetwork, getLatestLedger (with its header), and
 * getLedgerEntries for the network settings a session loads when it opens,
 * plus the instance and code of the workbench's guided Status Message
 * contract, so the wallet pre-submit flow can run into a session offline.
 * Every other key a test asks for reads as absent, which is what the network
 * says about a fresh throwaway account or a never-uploaded Wasm hash.
 *
 * Usage:
 *   node scripts/capture-session-fixture.mjs [rpc-url] [out]
 *   defaults: https://soroban-testnet.stellar.org
 *             packages/web-demo/tests/fixtures/testnet-fork.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// The SDK lives under packages/soroban-sim (pnpm does not hoist it).
const sdkEntry = createRequire(join(repoRoot, "packages/soroban-sim/package.json")).resolve("@stellar/stellar-sdk");
const { Address, xdr } = await import(pathToFileURL(sdkEntry).href);
/** The workbench's guided Testnet example (packages/web-demo/index.html). */
const STATUS_CONTRACT = "CBXVJXHPSYORSAHPX4I6NYPQMDJWK2STQCE6JTIM7FNV4OZSIDJFGNDM";
const rpcUrl = process.argv[2] ?? "https://soroban-testnet.stellar.org";
const out = process.argv[3] ?? join(repoRoot, "packages/web-demo/tests/fixtures/testnet-fork.json");

// ConfigSettingId values (stellar-xdr): the settings NetworkConfig and the
// session's transaction limits load (soroban-sim-facade's OPEN_SETTINGS).
const OPEN_SETTINGS = {
  contractComputeV0: 1,
  contractLedgerCostV0: 2,
  contractHistoricalDataV0: 3,
  contractEventsV0: 4,
  contractBandwidthV0: 5,
  contractCostParamsCpuInstructions: 6,
  contractCostParamsMemoryBytes: 7,
  stateArchival: 10,
  liveSorobanStateSizeWindow: 12,
  contractLedgerCostExtV0: 15,
};

/** LedgerKey::ConfigSetting XDR: the CONFIG_SETTING arm (8), then the id. */
function configKey(id) {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(8, 0);
  bytes.writeUInt32BE(id, 4);
  return bytes.toString("base64");
}

async function call(method, params = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    const json = await response.json();
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  }
}

const network = await call("getNetwork");
const latest = await call("getLatestLedger");
const settings = await call("getLedgerEntries", { keys: Object.values(OPEN_SETTINGS).map(configKey) });
if (settings.entries.length !== Object.keys(OPEN_SETTINGS).length) {
  throw new Error(`expected ${Object.keys(OPEN_SETTINGS).length} settings, got ${settings.entries.length}`);
}
// The Status Message contract: its instance, then the code it runs.
const instanceKey = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: new Address(STATUS_CONTRACT).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent,
  }),
).toXdr("base64");
const instance = await call("getLedgerEntries", { keys: [instanceKey] });
const instanceData = xdr.LedgerEntryData.fromXdr(instance.entries[0].xdr, "base64");
const wasmHash = instanceData.contractData.val.instance.executable.wasmHash;
const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash })).toXdr("base64");
const code = await call("getLedgerEntries", { keys: [codeKey] });
settings.entries.push(...instance.entries, ...code.entries);

const fixture = {
  rpcUrl,
  capturedAt: new Date().toISOString(),
  getNetwork: network,
  getLatestLedger: latest,
  entries: settings.entries.map(({ key, xdr, lastModifiedLedgerSeq, liveUntilLedgerSeq }) => ({
    key,
    xdr,
    lastModifiedLedgerSeq,
    ...(liveUntilLedgerSeq !== undefined ? { liveUntilLedgerSeq } : {}),
  })),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`${out}: ${network.passphrase} at ledger ${latest.sequence} (protocol ${latest.protocolVersion}), ${fixture.entries.length} entries`);
