import {
  StellarWalletsKit,
  type ModuleInterface,
} from "@creit.tech/stellar-wallets-kit";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import {
  NidoModule,
  NIDO_ID,
} from "@nidohq/stellar-wallets-kit-module";
import { Networks } from "@stellar/stellar-sdk";

const NIDO_BASE = "https://nido.fyi";
let initialized = false;

export interface ConnectedWallet {
  address: string;
  id: string;
  name: string;
}

export interface WalletSignResult {
  signedTxXdr: string;
  signerAddress?: string;
  /** Nido can relay a C-account transaction during its signing ceremony. */
  submitted?: true;
}

function modules(): ModuleInterface[] {
  return [
    new NidoModule({
      base: NIDO_BASE,
      networkPassphrase: Networks.TESTNET,
    }),
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
  ];
}

function init(): void {
  if (initialized) return;
  StellarWalletsKit.init({ modules: modules() });
  initialized = true;
}

/** Open the Wallets Kit picker. Nido is first, next to common G-account wallets. */
export async function connectWallet(): Promise<ConnectedWallet> {
  init();
  const { address } = await StellarWalletsKit.authModal();
  const selected = StellarWalletsKit.selectedModule;
  return {
    address,
    id: selected.productId,
    name: selected.productName,
  };
}

export async function disconnectWallet(): Promise<void> {
  if (!initialized) return;
  await StellarWalletsKit.disconnect();
}

/**
 * Ask the wallet to sign `xdr`. A network session keeps its network's real
 * passphrase, so the passphrase is the session's when signing into one.
 */
export async function signWithWallet(
  xdr: string,
  address: string,
  networkPassphrase: string = Networks.TESTNET,
): Promise<WalletSignResult> {
  init();
  return (await StellarWalletsKit.signTransaction(xdr, {
    address,
    networkPassphrase,
  })) as WalletSignResult;
}

export { NIDO_ID };
