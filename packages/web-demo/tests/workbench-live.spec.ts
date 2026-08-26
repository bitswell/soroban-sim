import { expect, test } from "@playwright/test";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const STATUS_CONTRACT = "CBXVJXHPSYORSAHPX4I6NYPQMDJWK2STQCE6JTIM7FNV4OZSIDJFGNDM";
const SOURCE = "GALD63KYDPYZLJLY2VD722RI6HAW3RIKU5AROSPAXTL5JRDJB5NGOJIX";

/**
 * Opt-in smoke test for the real Testnet boundary. CI stays deterministic and
 * offline; run locally with LIVE_TESTNET=1 when changing RPC/snapshot behavior.
 */
test("Nido Status Message write simulates locally against Testnet", async ({ page }) => {
  test.skip(!process.env.LIVE_TESTNET, "set LIVE_TESTNET=1 for the live RPC smoke test");
  test.setTimeout(180_000);

  await page.goto("/");
  const load = page.locator("#load-contract");
  await expect(load).toBeEnabled({ timeout: 60_000 });
  await load.click();
  await expect(page.locator("#contract-fn")).toBeVisible({ timeout: 90_000 });
  await page.locator("#contract-fn").selectOption("update_message");
  await expect(page.locator("#run")).toBeEnabled();
  await page.locator("#run").click();

  await expect(page.locator("#result-panel")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#result-note")).toContainText("executed in this Worker");
  await expect(page.locator("#r-value")).toContainText("Void · void");
  await expect(page.locator("#fp-rw-count")).toHaveText("1");
  await expect(page.locator("#fp-rw")).toContainText("Contract storage");
  await expect(page.locator("#fp-rw")).toContainText("Messages");
  await expect(page.locator("#fp-runtime-count")).toHaveText("2");
  await expect(page.locator("#fp-runtime")).toContainText("Restore Contract instance");
  await expect(page.locator("#fp-runtime")).toContainText("Restore Wasm code");
  await expect(page.locator("#fp-protocol-summary")).toHaveText(
    "0 read-only · 3 read-write",
  );
  await expect(page.locator("#impact-list .impact-item")).toHaveCount(1);
  await expect(page.locator("#impact-list")).toContainText("Host-managed restoration");
  await expect(page.locator("#submit-status")).toContainText("not submitted");
});

test("valid transaction XDR takes the same local Testnet path", async ({ page }) => {
  test.skip(!process.env.LIVE_TESTNET, "set LIVE_TESTNET=1 for the live RPC smoke test");
  test.setTimeout(180_000);

  const tx = new TransactionBuilder(new Account(SOURCE, "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      new Contract(STATUS_CONTRACT).call(
        "get_message",
        Address.fromString(SOURCE).toScVal(),
      ),
    )
    .setTimeout(0)
    .build();

  await page.goto("/");
  await expect(page.locator("#request-xdr")).toBeEnabled({ timeout: 60_000 });
  await page.locator("#request-xdr").click();
  await page.locator("#transaction-xdr").fill(tx.toEnvelope().toXdr("base64"));
  await expect(page.locator("#run")).toBeEnabled();
  await page.locator("#run").click();

  await expect(page.locator("#result-panel")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#result-note")).toContainText("executed in this Worker");
  await expect(page.locator("#r-value")).toContainText("Void · void");
  await expect(page.locator("#result-context")).toContainText("Transaction XDR");
  await expect(page.locator("#submit-source")).toContainText("GALD63…NGOJIX");
});
