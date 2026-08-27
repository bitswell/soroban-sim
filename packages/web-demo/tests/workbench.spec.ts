import { expect, test } from "@playwright/test";

test.describe("deployed contract / XDR workbench", () => {
  test("creates one disposable Testnet identity and keeps its secret out of the UI", async ({
    page,
  }) => {
    await page.goto("/");
    const address = await page.locator("#local-identity-address").textContent();
    expect(address).toMatch(/^G[A-Z2-7]+$/);
    await expect(page.locator("#review-submit")).toBeDisabled();
    await expect(page.locator("#submission-boundary")).toContainText(
      "No wallet prompt or network submission",
    );

    const secret = await page.evaluate(() => {
      const raw = localStorage.getItem("soroban-sim.testnet-identity.v1");
      return raw ? (JSON.parse(raw) as { secret: string }).secret : "missing";
    });
    expect(secret).toMatch(/^S[A-Z2-7]+$/);
    await expect(page.locator("body")).not.toContainText(secret);

    await page.reload();
    await expect(page.locator("#local-identity-address")).toHaveText(address!);
    await page.locator("#identity-wallet").click();
    await expect(page.locator("#wallet-identity-view")).toContainText("Nido");
    await expect(page.locator("#wallet-identity-view")).toContainText(
      "local G-account remains the fee payer",
    );
  });

  test("defaults to a guided Testnet contract call and explains local execution", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#request-contract")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#contract-id")).toHaveValue(/^C[A-Z2-7]+$/);
    await expect(page.locator("#mode-live")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#mode-live")).toBeDisabled();
    await expect(page.locator("#run")).toBeDisabled();
    await expect(page.locator(".mode-help")).toContainText(
      "Contract execution always stays in this browser",
    );
  });

  test("rejects malformed contract ids before making an RPC request", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#load-contract")).toBeEnabled({ timeout: 60_000 });
    await page.locator("#contract-id").fill("not-a-contract");
    await page.locator("#load-contract").click();
    await expect(page.locator("#contract-err")).toContainText("C… contract address");
    await expect(page.locator("#run")).toBeDisabled();
  });

  test("rejects malformed transaction XDR locally", async ({ page }) => {
    await page.goto("/");
    await page.locator("#request-xdr").click();
    await page.locator("#transaction-xdr").fill("not-base64-xdr");
    await expect(page.locator("#run")).toBeEnabled({ timeout: 60_000 });
    await page.locator("#run").click();
    await expect(page.locator("#result-panel")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#r-value")).toContainText("simulation failed");
    await expect(page.locator("#r-err")).toBeVisible();
  });
});
