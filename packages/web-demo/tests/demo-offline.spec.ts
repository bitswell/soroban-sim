import { expect, test } from "@playwright/test";

/**
 * Interactive demo — OFFLINE path only (deterministic, no network; CI-safe).
 * Drives the same rerun loop as the golden gate but through the UI: selecting a
 * fixture, running, and asserting contract-relevant state resolves and the
 * result decodes.
 * The live-testnet path is intentionally not exercised here — it depends on
 * external RPC and is presented in-product as "may fail".
 */

test.describe("interactive demo (offline)", () => {
  test("add_i32 resolves round-by-round to I32 · 42", async ({ page }) => {
    await page.goto("/");

    // Golden strip mirrors the runFixture browser run and should confirm the
    // byte-identical CI output on load.
    await expect(page.locator("#golden")).toHaveAttribute("data-status", "done", {
      timeout: 60_000,
    });
    await expect(page.locator("#golden-text")).toContainText("byte-identical");

    // Run button becomes enabled once the worker is ready.
    const run = page.locator("#run");
    await expect(run).toBeEnabled({ timeout: 60_000 });

    // add_i32 is the default fixture; run it.
    await run.click();

    // Result panel appears with the decoded return value.
    const resultPanel = page.locator("#result-panel");
    await expect(resultPanel).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#r-value")).toContainText("42");
    await expect(page.locator("#r-value")).toContainText("I32");

    // The loop needed multiple rounds (empty seed -> resolve every key).
    const rounds = Number(await page.locator("#m-rounds").textContent());
    expect(rounds).toBeGreaterThan(1);

    // Contract state is the primary view. Host configuration was resolved for
    // local execution, but is collapsed instead of presented as contract reads.
    const cols = await page.locator("#timeline .round").count();
    expect(cols).toBeGreaterThan(1);
    await expect(
      page.locator("#timeline .rkind", { hasText: "ConfigSetting" }),
    ).toHaveCount(0);
    await expect(page.locator("#snap-list")).not.toContainText("ConfigSetting");
    await expect(page.locator("#engine-state-summary")).toBeVisible();
    const executionEntries = Number(await page.locator("#m-keys").textContent());
    expect(executionEntries).toBeLessThan(rounds);

    // Snapshot accumulated present entries.
    const present = Number(await page.locator("#snap-present").textContent());
    expect(present).toBeGreaterThan(0);

    // Selecting a different request invalidates the completed output instead
    // of leaving results that describe the previous fixture on screen.
    await page.getByRole("button", { name: /SAC — transfer/ }).click();
    await expect(resultPanel).toBeHidden();
    await expect(page.locator("#timeline-empty")).toBeVisible();
    await expect(page.locator("#m-keys")).toHaveText("—");
  });

  test("switching to a deeper fixture works", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#run")).toBeEnabled({ timeout: 60_000 });

    // Select the SAC transfer fixture (deepest loop; returns void).
    await page.getByRole("button", { name: /SAC — transfer/ }).click();
    await page.locator("#run").click();

    await expect(page.locator("#result-panel")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#r-value")).toContainText("Void");
    const present = Number(await page.locator("#snap-present").textContent());
    expect(present).toBeGreaterThan(0);
  });
});
