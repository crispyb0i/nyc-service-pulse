import { expect, type Page } from "@playwright/test";
import { test } from "./browser-fixtures";
import type { PulseResponse } from "../src/lib/types";

const numberFormatter = new Intl.NumberFormat("en-US");
const formatCount = (value: number) => numberFormatter.format(value);

function fixture(overrides: Partial<PulseResponse> = {}): PulseResponse {
  return {
    summary: { total: 1, closed: 1, closedPercent: 100, medianClosureHours: 3, validClosureCount: 1, missingCoordinates: 0 },
    daily: Array.from({ length: 31 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, "0")}`, count: i === 30 ? 1 : 0 })),
    requests: [{ id: "QA-123", createdAt: "2026-08-31T12:00:00.000000", closedAt: "2026-08-31T15:00:00.000000", status: "Closed", agency: "NYPD", problem: "Noise - Residential", detail: "Loud music", borough: "BROOKLYN", qualityFlags: [] }],
    nextCursor: null,
    meta: { filters: { from: "2026-08-01", to: "2026-08-31", problem: null }, pageSize: 50, source: "https://data.cityofnewyork.us/resource/erm2-nwe9.json", timestampConvention: "Source floating timestamps preserved; publisher-local assumption.", dataFetchedAt: "2026-10-01T22:30:00Z", latestSourceUpdateAt: "2026-10-01T21:00:00Z", importStatus: "validated", importRunId: "qa-only", lastValidatedAt: "2026-10-01T22:30:00Z", generatedAt: "2026-10-01T22:30:00Z" },
    ...overrides,
  };
}

async function mockProblems(page: Page) {
  await page.route("**/api/problems*", (route) => route.fulfill({ json: { problems: [{ name: "Noise - Residential", count: 1 }] } }));
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`); });
  return errors;
}

test("local API rejects invalid dates and a cursor reused with different filters", async ({ request }) => {
  for (const query of ["from=2026-09-01", "from=2026-08-20&to=2026-08-10", "from=2026-08-01&from=2026-08-02", "cursor=", "cursor=bad-cursor"]) {
    const response = await request.get(`/api/pulse?${query}`);
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_FILTERS");
  }
  const response = await request.get("/api/pulse");
  expect(response.ok()).toBeTruthy();
  const data = await response.json() as PulseResponse;
  expect(data.nextCursor).not.toBeNull();
  const stale = await request.get(`/api/pulse?from=2026-08-02&cursor=${encodeURIComponent(data.nextCursor!)}`);
  expect(stale.status()).toBe(400);
  expect((await stale.json()).error.code).toBe("INVALID_FILTERS");
});

test("live API keeps complaint/date totals, daily counts, and keyset pages consistent", async ({ request }) => {
  const query = new URLSearchParams({ from: "2026-08-01", to: "2026-08-10" });
  const problemsResponse = await request.get(`/api/problems?${query}`);
  expect(problemsResponse.ok()).toBeTruthy();
  const problems = await problemsResponse.json() as { problems: { name: string; count: number }[] };
  expect(problems.problems.length).toBeGreaterThan(0);
  const problem = problems.problems[0];
  query.set("problem", problem.name);
  const response = await request.get(`/api/pulse?${query}`);
  expect(response.ok()).toBeTruthy();
  const first = await response.json() as PulseResponse;
  expect(first.summary.total).toBe(problem.count);
  expect(first.daily).toHaveLength(10);
  expect(first.daily.reduce((sum, day) => sum + day.count, 0)).toBe(first.summary.total);
  expect(first.requests).toHaveLength(Math.min(first.meta.pageSize, first.summary.total));
  for (const row of first.requests) {
    expect(row.problem).toBe(problem.name);
    expect(row.createdAt.slice(0, 10) >= "2026-08-01" && row.createdAt.slice(0, 10) <= "2026-08-10").toBeTruthy();
    expect(row.createdAt).not.toMatch(/Z|\+\d\d:/);
  }
  expect(first.nextCursor).not.toBeNull();
  query.set("cursor", first.nextCursor!);
  const nextResponse = await request.get(`/api/pulse?${query}`);
  expect(nextResponse.ok()).toBeTruthy();
  const next = await nextResponse.json() as PulseResponse;
  expect(next.summary).toEqual(first.summary);
  expect(next.daily).toEqual(first.daily);
  const firstIds = new Set(first.requests.map((row) => row.id));
  expect(next.requests.every((row) => !firstIds.has(row.id))).toBeTruthy();
});

async function waitForPulse(page: Page, action: () => Promise<unknown>, matches: (url: URL) => boolean = () => true) {
  const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pulse" && response.ok() && matches(new URL(response.url())));
  await action();
  return await (await pending).json() as PulseResponse;
}

async function assertDashboard(page: Page, data: PulseResponse) {
  await expect(page.locator(".metric-card").filter({ hasText: "Total requests" }).locator(".metric-value")).toHaveText(formatCount(data.summary.total));
  const bars = page.getByRole("group", { name: "Daily request counts" }).getByRole("button");
  await expect(bars).toHaveCount(data.daily.length);
  for (let i = 0; i < data.daily.length; i++) {
    const day = data.daily[i];
    await expect(bars.nth(i)).toHaveAttribute("aria-label", `Aug ${Number(day.date.slice(-2))}, 2026: ${formatCount(day.count)} requests`);
  }
  await expect(page.locator("tbody tr")).toHaveCount(data.requests.length);
  expect((await page.locator("tbody .request-id").allTextContents()).map((id) => id.trim())).toEqual(data.requests.map((row) => row.id));
}

test("desktop renders live data, shared filters, keyboard chart, and reversible pagination", async ({ page }) => {
  const errors = watchErrors(page);
  const initial = await waitForPulse(page, () => page.goto("/"));
  expect(initial.summary.total).toBeGreaterThan(0);
  await assertDashboard(page, initial);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A month of city life.");
  await page.screenshot({ path: "reports/ui-desktop.png", fullPage: true, animations: "disabled" });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to dashboard" })).toBeFocused();
  const bars = page.getByRole("group", { name: "Daily request counts" }).getByRole("button");
  await bars.first().focus();
  await page.keyboard.press("Tab");
  await expect(bars.nth(1)).toBeFocused();
  await expect(page.locator(".chart-summary")).toContainText("requests on Aug 2");

  await expect(page.getByLabel("Problem type").locator("option")).not.toHaveCount(1);
  const problem = await page.getByLabel("Problem type").locator("option").nth(1).getAttribute("value");
  expect(problem).toBeTruthy();
  await waitForPulse(page, () => page.getByLabel("Problem type").selectOption(problem!), (url) => url.searchParams.get("problem") === problem);
  await waitForPulse(page, () => page.getByLabel("From", { exact: true }).fill("2026-08-05"), (url) => url.searchParams.get("from") === "2026-08-05");
  const filtered = await waitForPulse(page, () => page.getByLabel("Through", { exact: true }).fill("2026-08-10"), (url) => url.searchParams.get("to") === "2026-08-10");
  await assertDashboard(page, filtered);
  expect(filtered.requests.every((row) => row.problem === problem && row.createdAt.slice(0, 10) >= "2026-08-05" && row.createdAt.slice(0, 10) <= "2026-08-10")).toBeTruthy();
  expect(new URL(page.url()).searchParams.get("problem")).toBe(problem);
  expect(filtered.daily.reduce((sum, day) => sum + day.count, 0)).toBe(filtered.summary.total);
  await page.screenshot({ path: "reports/ui-filtered.png", fullPage: true, animations: "disabled" });

  await expect(page.getByRole("button", { name: "Next page" })).toBeEnabled();
  const next = await waitForPulse(page, () => page.getByRole("button", { name: "Next page" }).click(), (url) => url.searchParams.has("cursor"));
  await assertDashboard(page, next);
  expect(next.summary).toEqual(filtered.summary);
  expect(next.daily).toEqual(filtered.daily);
  expect(next.requests.every((row) => !filtered.requests.some((first) => first.id === row.id))).toBeTruthy();
  await expect(page.locator(".table-pagination")).toContainText("requests on page 2");
  const previous = await waitForPulse(page, () => page.getByRole("button", { name: "Previous page" }).click(), (url) => !url.searchParams.has("cursor"));
  await assertDashboard(page, previous);
  expect(previous.requests.map((row) => row.id)).toEqual(filtered.requests.map((row) => row.id));
  const reset = await waitForPulse(page, () => page.getByRole("button", { name: "Reset filters", exact: true }).click(), (url) => !url.searchParams.has("problem") && url.searchParams.get("from") === "2026-08-01" && url.searchParams.get("to") === "2026-08-31");
  await assertDashboard(page, reset);
  await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("mobile keeps controls accessible and contains table scrolling within the page", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const data = await waitForPulse(page, () => page.goto("/"));
  await assertDashboard(page, data);
  await expect(page.getByLabel("Problem type")).toBeVisible();
  await expect(page.getByLabel("From", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Through", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset filters", exact: true })).toBeVisible();
  const unnamedNavigation = await page.locator("nav a").evaluateAll((links) => links.filter((link) => !(link.getAttribute("aria-label") || (link as HTMLElement).innerText).trim()).length);
  expect(unnamedNavigation).toBe(0);
  const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth, table: document.querySelector(".table-scroll")!.scrollWidth, tableViewport: document.querySelector(".table-scroll")!.clientWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.table).toBeGreaterThan(widths.tableViewport);
  await page.screenshot({ path: "reports/ui-mobile.png", fullPage: true, animations: "disabled" });
  await page.getByRole("region", { name: "Service request records. Scroll for more rows." }).evaluate((table) => { table.scrollLeft = table.scrollWidth; });
  await expect(page.getByRole("columnheader", { name: "Request ID" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("loading state is explicit before the first API response", async ({ page }) => {
  await mockProblems(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/pulse*", async (route) => { await gate; await route.fulfill({ json: fixture() }); });
  await page.goto("/");
  await expect(page.locator(".view-context").getByRole("status")).toContainText("Loading the local August dataset");
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.screenshot({ path: "reports/ui-loading.png", fullPage: true, animations: "disabled" });
  release();
  await expect(page.getByText("QA-123", { exact: true })).toBeVisible();
});

test("empty results show zero totals and useful empty chart and table states", async ({ page }) => {
  await mockProblems(page);
  const empty = fixture({ summary: { total: 0, closed: 0, closedPercent: 0, medianClosureHours: null, validClosureCount: 0, missingCoordinates: 0 }, requests: [], daily: fixture().daily.map((day) => ({ ...day, count: 0 })) });
  await page.route("**/api/pulse*", (route) => route.fulfill({ json: empty }));
  await page.goto("/");
  await assertDashboard(page, empty);
  await expect(page.getByText("No requests in this view", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No matching requests" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await page.screenshot({ path: "reports/ui-empty.png", fullPage: true, animations: "disabled" });
});

test("service failure presents the API message and recovers through Try again", async ({ page }) => {
  await mockProblems(page);
  let calls = 0;
  await page.route("**/api/pulse*", (route) => {
    calls++;
    return calls === 1
      ? route.fulfill({ status: 503, json: { error: { code: "DATA_UNAVAILABLE", message: "The local database is unavailable. Check that PostgreSQL is running and the schema is installed, then try again." } } })
      : route.fulfill({ json: fixture() });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "This view couldn’t load." })).toBeVisible();
  await expect(page.locator(".error-panel")).toContainText("The local database is unavailable.");
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.screenshot({ path: "reports/ui-error.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("QA-123", { exact: true })).toBeVisible();
  await expect(page.locator(".error-panel")).toHaveCount(0);
});

test("changing filters marks previous data busy until the replacement response arrives", async ({ page }) => {
  await mockProblems(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/pulse*", async (route) => {
    const filtered = new URL(route.request().url()).searchParams.has("problem");
    if (filtered) await gate;
    const response = fixture();
    if (filtered) response.meta.filters.problem = "Noise - Residential";
    await route.fulfill({ json: response });
  });
  await page.goto("/");
  await expect(page.getByText("QA-123", { exact: true })).toBeVisible();
  await page.getByLabel("Problem type").selectOption("Noise - Residential");
  await expect(page.locator(".view-context").getByRole("status")).toContainText("Updating chart and requests");
  await expect(page.locator(".data-content")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".data-content")).toHaveAttribute("inert", "");
  await page.screenshot({ path: "reports/ui-updating.png", fullPage: true, animations: "disabled" });
  release();
  await expect(page.locator(".data-content")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".view-context").getByRole("status")).toContainText("Noise - Residential");
  await expect(page.getByText("QA-123", { exact: true })).toBeVisible();
});
