/**
 * Choosing a fork point: the base network's last closed ledger, read over
 * RPC (`getNetwork`, `getLatestLedger`). The session keeps the network's real
 * passphrase, so every signature it checks is a real one.
 */
import { base64ToBytes } from "./base.js";
import type { ForkConfig } from "./session.js";
import type { ReadOnlyRpc } from "./rpc.js";

export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const MAINNET_RPC_URL = "https://mainnet.sorobanrpc.com";
export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";

/** The fields of a stellar-xdr LedgerHeader a fork point needs. */
export interface LedgerHeaderFields {
  ledgerVersion: number;
  closeTime: bigint;
  ledgerSeq: number;
  baseFee: number;
  baseReserve: number;
}

/**
 * Read the fork point fields out of LedgerHeader XDR without a full decoder:
 * `scpValue.upgrades` and its signed extension are the only variable-length
 * parts before `ledgerSeq`.
 */
export function parseLedgerHeader(bytes: Uint8Array): LedgerHeaderFields {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => view.getUint32(at);
  const padded = (n: number) => (n + 3) & ~3;
  const ledgerVersion = u32(0);
  // previousLedgerHash (32), then StellarValue: txSetHash (32), closeTime.
  const closeTime = view.getBigUint64(68);
  let at = 76;
  const upgrades = u32(at);
  at += 4;
  for (let i = 0; i < upgrades; i += 1) at += 4 + padded(u32(at));
  const valueType = u32(at);
  at += 4;
  if (valueType === 1) {
    // LedgerCloseValueSignature: NodeID (type + 32 bytes), Signature (opaque<64>).
    at += 4 + 32;
    at += 4 + padded(u32(at));
  }
  // txSetResultHash, bucketListHash.
  at += 64;
  const ledgerSeq = u32(at);
  // totalCoins, feePool (i64 each), inflationSeq (u32), idPool (u64).
  at += 4 + 8 + 8 + 4 + 8;
  return { ledgerVersion, closeTime, ledgerSeq, baseFee: u32(at), baseReserve: u32(at + 4) };
}

export interface ForkFromRpcOptions {
  /** `testnet`, `mainnet`, or the RPC URL (for the report). */
  networkName: string;
  /** Checked against the RPC's `getNetwork`. */
  expectedPassphrase?: string;
  secondsPerLedger?: number;
  allowRealSigners?: boolean;
  servedBy?: string;
}

/** The fork point at `rpc`'s latest ledger. */
export async function forkConfigFromRpc(
  rpc: ReadOnlyRpc,
  options: ForkFromRpcOptions,
): Promise<ForkConfig> {
  const network = await rpc.network();
  if (options.expectedPassphrase && network.passphrase !== options.expectedPassphrase) {
    throw new Error(
      `${rpc.url} serves ${JSON.stringify(network.passphrase)}, not ${JSON.stringify(options.expectedPassphrase)}`,
    );
  }
  const latest = await rpc.latestLedger();
  if (!latest.headerXdr) {
    throw new Error(`${rpc.url}: getLatestLedger returned no headerXdr (RPC too old?)`);
  }
  const headerXdr = base64ToBytes(latest.headerXdr);
  const header = parseLedgerHeader(headerXdr);
  return {
    networkName: options.networkName,
    networkPassphrase: network.passphrase,
    baseDescription: `RPC ${rpc.url} (getLedgerEntries at its latest ledger)`,
    forkLedger: latest.sequence,
    forkCloseTime: header.closeTime,
    protocolVersion: latest.protocolVersion,
    baseReserve: header.baseReserve,
    baseFee: header.baseFee,
    headerXdr,
    secondsPerLedger: options.secondsPerLedger ?? 5,
    allowRealSigners: options.allowRealSigners ?? false,
    servedBy: options.servedBy ?? "soroban-sim browser session",
  };
}
