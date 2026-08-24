import { expect, test } from "@playwright/test";

/**
 * Visual debugger — offline, deterministic. After a completed run the worker
 * stashes the accumulated entries; "debug this run" re-invokes the two-pass
 * `simulate-trace` export (enforcing replay under the tracing host) and the UI
 * renders a time-travel stepper over the recorded TraceEvents plus the Tier-1
 * fn_call/fn_return call tree.
 */

async function runFixtureAndOpenDebugger(
  page: import("@playwright/test").Page,
  fixtureName?: RegExp,
): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#run")).toBeEnabled({ timeout: 60_000 });
  if (fixtureName) await page.getByRole("button", { name: fixtureName }).click();
  await page.locator("#run").click();
  await expect(page.locator("#result-panel")).toBeVisible({ timeout: 60_000 });

  const debugBtn = page.locator("#debug-run");
  await expect(debugBtn).toBeVisible({ timeout: 10_000 });
  await debugBtn.click();
  await expect(page.locator("#debugger")).toBeVisible({ timeout: 60_000 });
}

test.describe("visual debugger (offline)", () => {
  test("add_i32: trace replays with steps, frame push, and budget attribution", async ({
    page,
  }) => {
    await runFixtureAndOpenDebugger(page);

    // Enforcing replay succeeded — no degraded-mode banner, scrubber visible.
    await expect(page.locator("#dbg-reason")).toBeHidden();
    await expect(page.locator("#dbg-scrub")).toBeVisible();

    // A real trace: begin + frame push/pop + end at minimum.
    const ticks = await page.locator("#dbg-ticks .dtick").count();
    expect(ticks).toBeGreaterThanOrEqual(4);
    await expect(page.locator("#dbg-count")).toContainText("steps");

    // Step 1 is `begin`; stepping lands on the VM frame push with decoded args.
    await expect(page.locator("#dbg-display")).toHaveText("begin");
    await page.locator("#dbg-fwd").click();
    await page.locator("#dbg-fwd").click();
    await expect(page.locator("#dbg-pos")).toContainText("step 3");
    await expect(page.locator("#dbg-display")).toContainText("add(");

    // Scrub to the end: cumulative CPU is the run's total (> 0).
    const max = await page.locator("#dbg-slider").getAttribute("max");
    await page.locator("#dbg-slider").fill(String(max));
    await page.locator("#dbg-slider").dispatchEvent("input");
    const cpu = await page.locator("#dbg-cpu-num").textContent();
    expect(Number((cpu ?? "0").replace(/,/g, ""))).toBeGreaterThan(0);

    // Tier-1 call tree has the root frame with decoded args and return.
    const frames = page.locator("#dbg-tree .tree-frame");
    expect(await frames.count()).toBeGreaterThanOrEqual(1);
    await expect(frames.first()).toContainText("add");
  });

  test("SAC transfer: storage ops populate the ledger lane and run-to-storage works", async ({
    page,
  }) => {
    await runFixtureAndOpenDebugger(page, /SAC — transfer/);

    await expect(page.locator("#dbg-scrub")).toBeVisible();
    await expect(page.locator("#dbg-count")).toContainText("storage ops");

    // The transfer touches contract storage — lane marks exist.
    const laneMarks = await page.locator("#dbg-lane .lane-mark").count();
    expect(laneMarks).toBeGreaterThan(0);

    // run-to-storage jumps to a storage env-call.
    const storageBtn = page.locator("#dbg-storage-btn");
    await expect(storageBtn).toBeEnabled();
    await storageBtn.click();
    await expect(page.locator("#dbg-display")).toContainText("contract_data");
    await expect(page.locator("#dbg-kind")).toContainText("storage");
  });
});
