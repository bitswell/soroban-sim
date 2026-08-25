/**
 * Committed fixture snapshots. These three JSON files are copies of the repo's
 * parity captures (`fixtures/parity/*.json`) — each carries a real transaction
 * envelope, ledger context, and a complete ledger snapshot captured from a
 * Stellar RPC `getLedgerEntries`. The demo runs the identical rerun loop over
 * them offline (snapshot seeded into an in-memory provider) and, for the SAC
 * read-only case, live against testnet RPC.
 */
import addI32 from "./fixtures/local-add-i32.json";
import sacDecimals from "./fixtures/native-sac-decimals.json";
import sacTransfer from "./fixtures/native-sac-transfer.json";

export interface RawFixture {
  networkPassphrase: string;
  case: string;
  functionName: string;
  contractId: string;
  txXdr: string;
  ledgerContext: {
    protocolVersion: number;
    sequenceNumber: number;
    timestamp: number;
    networkId: string;
    baseReserve: number;
    minTempEntryTtl: number;
    minPersistentEntryTtl: number;
    maxEntryTtl: number;
  };
  snapshot: { keyXdr: string; entryXdr: string; liveUntilLedger: number | null }[];
  rpc: { retvalXdr: string };
}

export interface FixtureMeta {
  id: string;
  /** Short mono label for the picker. */
  label: string;
  /** The call this fixture makes. */
  call: string;
  /** One line on where the snapshot came from + what it exercises. */
  note: string;
  /** Expected decoded return, shown as a hint before the run completes. */
  expect: string;
  /** True for the pre-wired read-only call that also runs against live testnet. */
  liveCapable: boolean;
  raw: RawFixture;
}

export const FIXTURES: FixtureMeta[] = [
  {
    id: "add_i32",
    label: "add_i32 — add(7, 35)",
    call: "add(7, 35) → i32",
    note: "Custom Wasm, captured from a local protocol-28 node.",
    expect: "I32 · 42",
    liveCapable: false,
    raw: addI32 as unknown as RawFixture,
  },
  {
    id: "sac_decimals",
    label: "SAC — decimals()",
    call: "decimals() → u32",
    note: "Native asset contract, read-only. The pre-wired live-testnet call.",
    expect: "U32 · 7",
    liveCapable: true,
    raw: sacDecimals as unknown as RawFixture,
  },
  {
    id: "sac_transfer",
    label: "SAC — transfer()",
    call: "transfer(from, to, amount) → void",
    note: "Native asset transfer: write + auth + contract-event footprint.",
    expect: "Void",
    liveCapable: false,
    raw: sacTransfer as unknown as RawFixture,
  },
];

export function fixtureById(id: string): FixtureMeta {
  const f = FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`unknown fixture ${id}`);
  return f;
}

/** The one fixture wired for live testnet. */
export const LIVE_FIXTURE_ID = "sac_decimals";
export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
