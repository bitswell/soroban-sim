// Types for @theahaco/soroban-sign-dialog.

export interface TokenInfo { code: string; decimals: number }
/** Names for addresses: a plain name, or a name with token metadata. */
export type Labels = Record<string, string | { name?: string; token?: TokenInfo }>;

export type CredentialsType = 'source-account' | 'address' | 'address-v2' | 'address-with-delegates';

export interface ApprovedEntry {
  index: number;
  /** The authorizing address (G… or C…), or null for source-account credentials. */
  address: string | null;
  credentials: CredentialsType;
  nonce: string | null;
  /** Base64 SorobanAuthorizationEntry, exactly as requested. */
  entryXdr: string;
  /** Base64 SorobanAuthorizedInvocation the user reviewed. */
  invocationXdr: string;
  /** Hex sha256 of invocationXdr; check it against what you sign. */
  invocationHash: string;
  /** True when address equals the dialog's `signer`. */
  forSigner: boolean;
}

export type Flag =
  | { kind: 'extra' | 'differs'; entry: number }
  | { kind: 'missing'; recorded: number }
  | { kind: 'refused'; address: string; code?: number }
  | { kind: 'fails'; error: string | null }
  | { kind: 'not-simulated'; code: string | null };

export interface ApproveDetail {
  transaction: string | null;
  /** Hex hash of the (inner) transaction on this network. */
  transactionHash: string | null;
  networkPassphrase: string;
  signer: string | null;
  entries: ApprovedEntry[];
  flags: Flag[];
  preview: PreviewResult | null;
}

export type RejectReason = 'rejected' | 'dismissed' | 'closed' | 'superseded';
export interface RejectDetail { reason: RejectReason; flags: Flag[] }
export interface PreviewDetail { result: PreviewResult; flags: Flag[] }

export interface PreviewRequest {
  transaction: string | null;
  authEntries: string[];
  networkPassphrase: string;
  signer: string | null;
  rpcUrl: string | null;
  decoded: unknown;
  signal: AbortSignal;
}

export interface Verdict {
  address: string;
  kind: string;
  /** null: unknown (the enforcing run failed for a reason outside this account). */
  allowed: boolean | null;
  rule?: { id: number; name?: string; grant?: number | null };
  code?: number;
  reasonCode?: string;
  params?: Record<string, unknown>;
  reason?: string;
}

export interface Budget {
  address: string;
  rule?: { id: number; name?: string; grant?: number | null };
  token: TokenInfo & { contract?: string };
  limit: string;
  periodLedgers: number;
  spentInWindow: string;
  amount: string;
  ledger: number;
  nextReleaseLedger: number | null;
}

export interface BalanceChange { address: string; asset: TokenInfo & { contract?: string }; before: string; after: string }

/** What a preview provider returns (version 1). */
export interface PreviewResult {
  version?: 1;
  status: 'ok' | 'fallback' | 'error';
  /** A machine-readable notice: a key of `strings.notices`. */
  code?: string;
  params?: Record<string, unknown>;
  /** English text for `code`, used when the strings have no entry for it. */
  notice?: string;
  engine?: { name: string; host: string | null; protocol: number | null; builds?: number[] };
  ledger?: { sequence: number; protocol: number };
  stateSource?: string;
  /** Base64 SorobanAuthorizationEntry list the simulation recorded on its own. */
  recordedAuth?: string[];
  /** codes: contract errors, each with the contract that raised it (null for the host). */
  outcome?: { ok: boolean; error: string | null; codes: { contract: string | null; code: number }[] };
  verdicts?: Verdict[];
  budgets?: Budget[];
  balances?: BalanceChange[];
  /** Base64 ContractEvent list. */
  events?: string[];
  resources?: { instructions: number };
  timings?: Record<string, unknown>;
}

export type PreviewProvider = (request: PreviewRequest) => Promise<PreviewResult>;

type Text<P = never> = [P] extends [never] ? string : string | ((params: P) => string);
/** Every user-facing string; values are HTML, parameters arrive escaped. */
export type Strings = { [key: string]: unknown } & {
  networks: Record<'testnet' | 'mainnet' | 'futurenet' | 'local', string>;
  notices: Record<string, string | ((params: any) => string)>;
  reasons: Record<string, string | ((params: any) => string)>;
  balanceHeaders: [string, string, string, string, string];
  approveButton: Text; reject: Text; approveAnyway: Text; confirmApproveAnyway: Text; details: Text;
};
export type StringOverrides = Partial<Omit<Strings, 'networks' | 'notices' | 'reasons'>> & {
  networks?: Partial<Strings['networks']>;
  notices?: Strings['notices'];
  reasons?: Strings['reasons'];
  [key: string]: unknown;
};
export declare const STRINGS: Strings;

export interface RequestOptions {
  transaction?: string;
  authEntries?: string[];
  /** `testnet`, `mainnet`, `futurenet`, `local` or a passphrase. */
  network?: string;
  networkPassphrase?: string;
  signer?: string;
  dapp?: string;
  engine?: string;
  rpcUrl?: string;
  theme?: 'light' | 'dark';
  preview?: 'manual' | 'auto' | 'off';
  strict?: boolean;
  labels?: Labels;
  strings?: StringOverrides;
  previewProvider?: PreviewProvider;
}

export type RequestResult = ({ approved: true } & ApproveDetail) | { approved: false; reason: RejectReason };

export interface SorobanSignDialogEventMap extends HTMLElementEventMap {
  approve: CustomEvent<ApproveDetail>;
  reject: CustomEvent<RejectDetail>;
  preview: CustomEvent<PreviewDetail>;
  open: CustomEvent<void>;
  close: CustomEvent<void>;
}

export declare class SorobanSignDialog extends HTMLElement {
  static observedAttributes: string[];
  transaction: string | null;
  authEntries: string[];
  /** Set a name or passphrase; reads back the passphrase. */
  network: string;
  networkPassphrase: string;
  signer: string | null;
  dapp: string | null;
  engine: string | null;
  rpcUrl: string | null;
  strict: boolean;
  labels: Labels;
  strings: StringOverrides;
  previewProvider: PreviewProvider | null;
  readonly previewResult: PreviewResult | null;
  readonly flags: Flag[];
  readonly open: boolean;
  readonly dialog: HTMLDialogElement;
  show(): void;
  close(): void;
  request(options?: RequestOptions): Promise<RequestResult>;
  runPreview(): Promise<void>;
  addEventListener<K extends keyof SorobanSignDialogEventMap>(type: K, listener: (this: SorobanSignDialog, ev: SorobanSignDialogEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof SorobanSignDialogEventMap>(type: K, listener: (this: SorobanSignDialog, ev: SorobanSignDialogEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

declare global {
  interface HTMLElementTagNameMap { 'soroban-sign-dialog': SorobanSignDialog }
}

export declare const TAG: 'soroban-sign-dialog';
export declare const VERSION: string;
/** Register the element (idempotent; a no-op without custom elements). */
export declare function define(tag?: string): void;
/** Open a shared dialog for one request, defining the element on first use. */
export declare function request(options?: RequestOptions): Promise<RequestResult>;

// The decoder. Decoded shapes are plain objects; see src/xdr.js.
export declare class XdrError extends Error {}
export declare const NETWORKS: Record<'testnet' | 'mainnet' | 'futurenet' | 'local', string>;
export declare function decodeEnvelope(xdr: string | Uint8Array): any;
export declare function decodeAuthEntry(xdr: string | Uint8Array): any;
export declare function decodeEvent(xdr: string | Uint8Array): any;
export declare function decodeLedgerEntry(xdr: string | Uint8Array): any;
export declare function decodeLedgerKey(xdr: string | Uint8Array): any;
export declare function decodeScVal(xdr: string | Uint8Array): any;
export declare function compareAuth(supplied: any[], recorded: any[]): { entries: { index: number; status: 'match' | 'extra' | 'differs'; recorded?: number }[]; missing: number[] };
export declare function authPayloadHash(entry: any, passphrase: string, expirationLedger?: number): Promise<Uint8Array | null>;
export declare function transactionHash(decoded: any, passphrase: string): Promise<Uint8Array>;
export declare function nativeAssetContract(passphrase: string): Promise<string>;
export declare function networkId(passphrase: string): Promise<Uint8Array>;
export declare function formatAmount(value: bigint, decimals?: number): string;
export declare function strkeyFor(kind: 'account' | 'contract' | 'muxed' | 'claimable' | 'pool', key: Uint8Array, id?: bigint): string;
export declare function fromStrkey(strkey: string): Uint8Array;
