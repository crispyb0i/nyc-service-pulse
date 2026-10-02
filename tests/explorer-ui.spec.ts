import { expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test } from "./browser-fixtures";

test("page turns and cached back navigation leave aggregates and map interactive", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (request) => calls.push(new URL(request.url()).pathname));
  await page.goto("/");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  const first = await page.locator("tbody .request-id").first().textContent();
  const summary = await page.locator(".metric-value").allTextContents();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/requests?*", async (route) => { await gate; await route.continue(); });
  const initialCalls = calls.filter((path) => path === "/api/pulse").length;
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Loading requests…", { exact: true })).toBeVisible();
  await expect(page.locator("#map")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".data-content")).not.toHaveAttribute("inert", "");
  release();
  await expect(page.locator("tbody .request-id").first()).not.toHaveText(first!);
  expect(await page.locator(".metric-value").allTextContents()).toEqual(summary);
  expect(calls.filter((path) => path === "/api/pulse")).toHaveLength(initialCalls);
  const pageCalls = calls.filter((path) => path === "/api/requests").length;
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.locator("tbody .request-id").first()).toHaveText(first!);
  expect(calls.filter((path) => path === "/api/requests")).toHaveLength(pageCalls);
  await page.goBack();
  await expect(page.locator(".table-pagination")).toContainText("page 2");
  await page.reload();
  await expect(page.locator("tbody .request-id").first()).not.toHaveText(first!);
});

test("continuous traversal bounds cache and DOM after a thousand records, and supports keyboard focus", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("button", { name: "Continuous list", exact: true }).click();
  const scroll = page.getByRole("region", { name: "Continuous service requests", exact: true });
  await expect(scroll.locator("li").first()).toBeVisible();
  for (let turn = 0; turn < 21; turn++) {
    const next = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/requests" && response.ok());
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const response = await next;
    expect((await response.body()).byteLength).toBeLessThanOrEqual(50_000);
    await expect(page.locator(".explorer-feedback")).not.toContainText("Loading");
    expect(Number(await page.locator("#requests").getAttribute("data-cached-pages"))).toBeLessThanOrEqual(8);
    expect(Number(await page.locator("#requests").getAttribute("data-cached-rows"))).toBeLessThanOrEqual(400);
    expect(await scroll.locator("li").count()).toBeLessThanOrEqual(20);
  }
  await scroll.evaluate((element) => { element.scrollTop = 0; });
  const first = scroll.locator('[data-row-index="0"]');
  await expect(first).toBeVisible();
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(scroll.locator('[data-row-index="1"]')).toBeFocused();
  await page.getByRole("button", { name: "Load earlier requests" }).click();
  await expect(page.locator(".explorer-feedback")).not.toContainText("Loading");
  expect(Number(await page.locator("#requests").getAttribute("data-cached-rows"))).toBeLessThanOrEqual(400);
});

test("day selection, request details and explicit map area survive shared URLs and browser history", async ({ page }) => {
  await page.goto("/");
  const bars = page.getByRole("group", { name: "Daily request counts" }).getByRole("button");
  await bars.nth(14).click();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2026-08-15");
  await expect(page.getByLabel("Through", { exact: true })).toHaveValue("2026-08-15");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  const opener = page.locator("tbody .request-open").first();
  const id = (await page.locator("tbody .request-id").first().textContent())!.trim();
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(id);
  expect(new URL(page.url()).searchParams.get("request")).toBe(id);
  await page.reload();
  await expect(dialog).toContainText(id);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const scoped = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/requests" && new URL(response.url()).searchParams.has("west") && response.ok());
  await page.getByRole("button", { name: "Search this area" }).click();
  const data = await (await scoped).json();
  await expect(page.locator("#requests")).toContainText("Selected map area");
  expect(new URL(page.url()).searchParams.has("area")).toBeTruthy();
  for (const row of data.requests) { expect(row.longitude).toBeGreaterThanOrEqual(data.bounds[0]); expect(row.latitude).toBeLessThanOrEqual(data.bounds[3]); }
  await page.getByRole("button", { name: "Clear map area" }).click();
  await expect(page.locator("#requests")).not.toContainText("Selected map area");
});

test("request-page failures retry locally and filters reset pagination", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  let calls = 0;
  await page.route("**/api/requests?*", (route) => ++calls === 1 ? route.fulfill({ status: 503, json: { error: { message: "Request service unavailable" } } }) : route.continue());
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator("#requests").getByRole("alert")).toContainText("Request service unavailable");
  await page.getByRole("button", { name: "Retry requests", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await expect(page.locator(".table-pagination")).toContainText("page 2");
  await page.getByLabel("Problem type").selectOption("Noise - Residential");
  await expect(page.locator(".table-pagination")).toContainText("page 1");
  await expect(page.locator("tbody .problem-cell strong").first()).toHaveText("Noise - Residential");
});

test("desktop and mobile browsing modes have no automated WCAG A/AA violations", async ({ page }) => {
  test.setTimeout(90_000);
  for (const width of [1440,390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await expect(page.locator("tbody tr")).toHaveCount(50);
    await page.locator("#map").scrollIntoViewIfNeeded();
    await expect(page.locator("#map .map-stale")).toHaveCount(0);
    for (const mode of ["Paged table", "Continuous list"]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      const results = await new AxeBuilder({ page }).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
      expect(results.violations.map((item) => ({ id: item.id, nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })) }))).toEqual([]);
    }
    await page.getByRole("region", { name: "Continuous service requests", exact: true }).getByRole("button").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const details = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(details.violations.map((item) => ({ id: item.id, nodes: item.nodes.map((node) => node.failureSummary) }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
});

test("the map becomes usable while summary data is still pending", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/pulse?*", async (route) => { await gate; await route.continue(); });
  await page.goto("/");
  await page.locator("#map").scrollIntoViewIfNeeded();
  await expect(page.locator("#map .map-request-cluster").first()).toBeVisible();
  await expect(page.locator(".view-context")).toContainText("Loading");
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeEnabled();
  const mapTopBefore = await page.locator("#map").evaluate((element) => element.getBoundingClientRect().top + scrollY);
  release();
  await expect(page.locator("tbody tr")).toHaveCount(50);
  const mapTopAfter = await page.locator("#map").evaluate((element) => element.getBoundingClientRect().top + scrollY);
  expect(Math.abs(mapTopAfter - mapTopBefore)).toBeLessThanOrEqual(2);
});

test("Back cancels a pending page without leaving a cached page busy", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  const ids = await page.locator("tbody .request-id").allTextContents();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/requests?*", async (route) => { await gate; await route.continue(); });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".explorer-feedback")).toContainText("Loading");
  await page.goBack();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  expect(await page.locator("tbody .request-id").allTextContents()).toEqual(ids);
  release();
});

test("a continuous-list deep link restores one contiguous page window", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.locator(".table-pagination")).toContainText(`page ${i + 2}`);
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  }
  const firstId = (await page.locator("tbody .request-id").first().textContent())!.trim();
  await page.getByRole("button", { name: "Continuous list", exact: true }).click();
  await page.reload();
  const scroll = page.getByRole("region", { name: "Continuous service requests", exact: true });
  await expect(scroll.locator('li').first()).toHaveAttribute("aria-posinset", "101");
  await expect(scroll.getByRole("button").first()).toContainText(firstId);
  await expect(page.locator("#requests")).toHaveAttribute("data-cached-rows", "50");
});

test("late request pages are discarded when the selected problem changes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const captured = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/requests?*", async (route) => {
    const response = await route.fetch(); started(); await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await captured;
  await page.getByLabel("Problem type").selectOption("Noise - Residential");
  await expect(page.locator("tbody .problem-cell strong").first()).toHaveText("Noise - Residential");
  const ids = await page.locator("tbody .request-id").allTextContents();
  release();
  await page.waitForTimeout(300);
  expect(await page.locator("tbody .request-id").allTextContents()).toEqual(ids);
  await expect(page.locator(".table-pagination")).toContainText("page 1");
});
