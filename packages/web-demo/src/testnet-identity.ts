import { Keypair } from "@stellar/stellar-sdk";

const STORAGE_KEY = "soroban-sim.testnet-identity.v1";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

interface StoredIdentity {
  publicKey: string;
  secret: string;
  createdAt: string;
}

export interface TestnetIdentity {
  publicKey: string;
  createdAt: string;
}

function readStored(): StoredIdentity | undefined {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as StoredIdentity;
    const keypair = Keypair.fromSecret(parsed.secret);
    if (keypair.publicKey() !== parsed.publicKey) throw new Error("public key mismatch");
    return parsed;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return undefined;
  }
}

/**
 * Return the disposable Testnet identity for this browser, creating it once.
 * The secret never leaves browser storage and is never rendered. This identity
 * is deliberately unavailable to Mainnet code paths.
 */
export function ensureTestnetIdentity(): TestnetIdentity {
  let stored = readStored();
  if (!stored) {
    const keypair = Keypair.random();
    stored = {
      publicKey: keypair.publicKey(),
      secret: keypair.secret(),
      createdAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }
  return { publicKey: stored.publicKey, createdAt: stored.createdAt };
}

/** Load the private key only at the moment the user approves signing. */
export function loadTestnetKeypair(): Keypair {
  const stored = readStored();
  if (!stored) throw new Error("the local Testnet identity is unavailable");
  return Keypair.fromSecret(stored.secret);
}

/** Fund the disposable identity. Friendbot is Testnet-only by construction. */
export async function fundTestnetIdentity(publicKey: string): Promise<void> {
  const stored = readStored();
  if (!stored || stored.publicKey !== publicKey) {
    throw new Error("refusing to fund an address that is not the local Testnet identity");
  }
  const url = new URL(FRIENDBOT_URL);
  url.searchParams.set("addr", publicKey);
  const response = await fetch(url);
  if (response.ok) return;
  let detail = `Friendbot returned HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { detail?: string };
    if (body.detail) detail = body.detail;
  } catch {
    // Keep the status-based error when Friendbot did not return JSON.
  }
  throw new Error(detail);
}
