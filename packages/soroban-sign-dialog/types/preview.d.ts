// Types for @theahaco/soroban-sign-dialog/preview, the lazy engine.
import type { PreviewProvider, PreviewRequest, PreviewResult, TokenInfo } from './index.js';

/** What the wallet knows about one of its accounts' keys. */
export interface SignerHint {
  /** The verifier contract (C…) the account checks this key with. */
  verifier: string;
  /** The key's public bytes, hex. */
  key: string;
  /** Grant and rule ids, to prefetch their storage. */
  grantId?: number;
  ruleId?: number;
  /** Rule ids the entry's AuthPayload selects, one per authorized call. */
  ruleIds?: number[];
}

export interface LedgerEntryRecord { key: string; entry: string; liveUntil: number | null }

export interface StateProvider {
  describe?(): string;
  getLatestLedger(): Promise<{ sequence: number; protocolVersion: number; closeTime: number; headerXdr?: string }>;
  getLedgerEntries(keys: string[]): Promise<{ entries: LedgerEntryRecord[]; latestLedger: number }>;
}

export interface PreviewOptions {
  rpcUrl?: string;
  stateProvider?: StateProvider;
  hints?: Record<string, SignerHint>;
  tokens?: Record<string, TokenInfo>;
  /** Where to load a protocol's reactor from: a URL or the wasm bytes. */
  wasm?: (protocol: number) => string | URL | BufferSource | Promise<string | URL | BufferSource>;
  /** Run the reactor on the calling thread instead of a Worker. */
  inline?: boolean;
}

export declare const BUILDS: Record<number, { host: string; wasm: string }>;
export declare function createPreview(options?: PreviewOptions): PreviewProvider;
export declare function preview(request: Partial<PreviewRequest> & PreviewOptions & { networkPassphrase: string }): Promise<PreviewResult>;
export declare function rpcProvider(url: string): StateProvider;
export declare function fixtureProvider(options: { ledger: LedgerEntryRecord[]; latest: { sequence: number; protocolVersion: number; closeTime: number }; latency?: number; name?: string }): StateProvider;
