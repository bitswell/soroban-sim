import { expect, test } from "@playwright/test";

test.describe("deployed contract / XDR workbench", () => {
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
