import { writeFileSync } from "node:fs";
import { expect, type Page, type Route } from "@playwright/test";
import { test, STREET_TILE_PATTERN, fulfillStreetTile } from "./browser-fixtures";
import { MAP_STUDY_BOUNDS, MAX_GRID_FEATURES, MAX_POINT_FEATURES, type MapBounds, type MapResponse } from "../src/lib/map-types";
import type { PulseResponse } from "../src/lib/types";

function mapQuery(bounds: MapBounds = MAP_STUDY_BOUNDS, zoom = 10, filters: Record<string, string> = {}) {
  return new URLSearchParams({ west: String(bounds[0]), south: String(bounds[1]), east: String(bounds[2]), north: String(bounds[3]), zoom: String(zoom), ...filters });
}

function assertMapCounts(data: MapResponse) {
  expect(data.features.reduce((sum, feature) => sum + feature.count, 0)).toBe(data.visibleRequests);
  expect(new Set(data.features.map((feature) => feature.id)).size).toBe(data.features.length);
  expect(data.features.length).toBeLessThanOrEqual(data.mode === "points" ? MAX_POINT_FEATURES : MAX_GRID_FEATURES);
  for (const feature of data.features) {
    expect(feature.count).toBeGreaterThan(0);
    expect(Number.isInteger(feature.count)).toBeTruthy();
    expect(feature.longitude).toBeGreaterThanOrEqual(data.meta.studyBounds[0]);
    expect(feature.longitude).toBeLessThanOrEqual(data.meta.studyBounds[2]);
    expect(feature.latitude).toBeGreaterThanOrEqual(data.meta.studyBounds[1]);
    expect(feature.latitude).toBeLessThanOrEqual(data.meta.studyBounds[3]);
    if (data.mode === "points") {
      expect(feature.count).toBe(1);
      expect(feature.request?.id).toBeTruthy();
    } else {
      expect(feature.request).toBeUndefined();
    }
  }
}

test("real map aggregates retain every geocoded request and share dashboard filters", async ({ request }) => {
  for (const filters of [{}, { from: "2026-08-05", to: "2026-08-10", problem: "Noise - Residential" }] as Record<string, string>[]) {
    const pulseResponse = await request.get(`/api/pulse?${new URLSearchParams(filters)}`);
    const mapResponse = await request.get(`/api/map?${mapQuery(MAP_STUDY_BOUNDS, 10, filters)}`);
    expect(pulseResponse.ok()).toBeTruthy();
    expect(mapResponse.ok()).toBeTruthy();
    const pulse = await pulseResponse.json() as PulseResponse;
    const map = await mapResponse.json() as MapResponse;
    assertMapCounts(map);
    expect(map.filters).toEqual(pulse.meta.filters);
    // This measured August snapshot has no coordinate-bearing records outside the study boundary.
    expect(map.visibleRequests).toBe(pulse.summary.total - pulse.summary.missingCoordinates);
    expect(pulse.daily.reduce((sum, day) => sum + day.count, 0)).toBe(pulse.summary.total);
    expect(map.mode).toBe("grid");
  }
});

test("map rejects unsafe viewport parameters and caps detail mode without truncating dense areas", async ({ request }) => {
  const valid = mapQuery();
  for (const extra of ["zoom=NaN", "west=-200", "north=90", "zoom=8", "zoom=19", "west=0", "cursor=abc"]) {
    const params = new URLSearchParams(valid);
    const [key, value] = extra.split("=");
    params.set(key, value);
    const response = await request.get(`/api/map?${params}`);
    expect(response.status(), extra).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_FILTERS");
  }
  const duplicate = await request.get(`/api/map?${valid}&zoom=12`);
  expect(duplicate.status()).toBe(400);
  const missing = await request.get("/api/map");
  expect(missing.status()).toBe(400);

  const denseResponse = await request.get(`/api/map?${mapQuery(MAP_STUDY_BOUNDS, 18)}`);
  expect(denseResponse.ok()).toBeTruthy();
  let data = await denseResponse.json() as MapResponse;
  assertMapCounts(data);
  expect(data.visibleRequests).toBeGreaterThan(MAX_POINT_FEATURES);
  expect(data.mode).toBe("grid");
  for (let depth = 0; depth < 4 && data.mode !== "points"; depth++) {
    const sparse = [...data.features].sort((a, b) => a.count - b.count)[0];
    expect(sparse).toBeTruthy();
    const response = await request.get(`/api/map?${mapQuery(sparse.bounds, 18)}`);
    expect(response.ok()).toBeTruthy();
    data = await response.json() as MapResponse;
    assertMapCounts(data);
  }
  expect(data.mode).toBe("points");
  expect(data.features.length).toBeGreaterThan(0);
  expect(data.features.length).toBeLessThanOrEqual(MAX_POINT_FEATURES);
  expect(new Set(data.features.map((feature) => feature.request!.id)).size).toBe(data.features.length);
});

const metrics: Record<string, unknown> = {
  capturedAt: new Date().toISOString(),
  browser: "Installed Google Chrome, ephemeral headless context",
  method: "Automation action start to response headers and DOM feature/list settlement plus two animation frames; includes automation overhead. These are local interaction observations, not FPS or production SLO claims.",
  interactions: [],
};
const samples = metrics.interactions as Record<string, unknown>[];
test.afterAll(() => writeFileSync("reports/portfolio/map-browser-metrics.json", JSON.stringify(metrics, null, 2) + "\n"));
const number = new Intl.NumberFormat("en-US");
const panel = (page: Page) => page.locator("#map");
const canvas = (page: Page) => panel(page).getByRole("region", { name: "NYC service request map. Use arrow keys to pan, plus and minus to zoom." });
const markers = (page: Page) => panel(page).locator(".map-request-cluster, .map-request-point");

async function assertMapUI(page: Page, data: MapResponse) {
  await expect(panel(page).getByTestId("map-visible-count")).toHaveText(number.format(data.visibleRequests));
  await expect(panel(page).locator(".map-stale")).toHaveCount(0);
  await expect(markers(page)).toHaveCount(data.features.length);
  await expect(panel(page).locator(".map-accessible-list li")).toHaveCount(data.features.length);
  expect(await panel(page).locator(".map-accessible-list li strong").allTextContents()).toEqual(data.features.map((feature, index) => feature.request ? `${feature.request.problem} · ${feature.request.id}` : `Area ${index + 1} · ${number.format(feature.count)} requests`));
  assertMapCounts(data);
}

async function mapAction(page: Page, name: string, action: () => Promise<unknown>, matches: (url: URL) => boolean = () => true) {
  const start = performance.now();
  let headers = start;
  const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/map" && response.ok() && matches(new URL(response.url()))).then((response) => { headers = performance.now(); return response; });
  await action();
  const response = await pending;
  const data = await response.json() as MapResponse;
  await assertMapUI(page, data);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const settled = performance.now();
  samples.push({ scenario: test.info().title, name, interactionToResponseMs: Math.round(headers - start), responseToDomSettledMs: Math.round(settled - headers), interactionToDomSettledMs: Math.round(settled - start), zoom: data.zoom, mode: data.mode, featureCount: data.features.length, visibleRequests: data.visibleRequests, responseBytes: (await response.body()).byteLength });
  return data;
}

async function openMap(page: Page) {
  return mapAction(page, "initial map load", async () => {
    await page.goto("/");
    await panel(page).scrollIntoViewIfNeeded();
  });
}

function monitor(page: Page) {
  const errors: string[] = [];
  const outbound: string[] = [];
  const tileRequests: string[] = [];
  const mapRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`); });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/map") mapRequests.push(request.url());
    if (url.origin === "https://tile.openstreetmap.org" && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname) && !url.search && request.resourceType() === "image") tileRequests.push(request.url());
    else if (["http:", "https:"].includes(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname)) outbound.push(request.url());
  });
  return { errors, outbound, tileRequests, mapRequests };
}

async function expandList(page: Page) {
  const list = panel(page).locator(".map-accessible-list");
  if (await list.getAttribute("open") === null) await list.locator("summary").click();
}

test("desktop map shares filters, zooms clusters, supports keyboard exploration, and opens real request details", async ({ page }) => {
  test.setTimeout(90_000);
  const observed = monitor(page);
  const initialPulsePending = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pulse" && response.ok()).then((response) => response.json() as Promise<PulseResponse>);
  let data = await openMap(page);
  const initialPulse = await initialPulsePending;
  expect(data.features.length).toBeGreaterThan(0);
  expect(data.mode).toBe("grid");
  await expect(panel(page).locator(".map-status-line")).toContainText(`${number.format(initialPulse.summary.missingCoordinates)} without coordinates · retained in totals and table`);
  await panel(page).screenshot({ path: "reports/portfolio/map-desktop.png", animations: "disabled" });

  const denseIndex = data.features.reduce((best, feature, index, all) => feature.count > all[best].count ? index : best, 0);
  const previousZoom = data.zoom;
  data = await mapAction(page, "cluster click", () => markers(page).nth(denseIndex).click(), (url) => Number(url.searchParams.get("zoom")) > previousZoom);
  expect(data.zoom).toBeGreaterThan(previousZoom);
  await canvas(page).focus();
  const west = data.bounds[0];
  data = await mapAction(page, "keyboard pan", () => page.keyboard.press("ArrowRight"), (url) => Number(url.searchParams.get("west")) !== west);
  const beforeZoom = data.zoom;
  data = await mapAction(page, "keyboard zoom", () => page.keyboard.press("+"), (url) => Number(url.searchParams.get("zoom")) > beforeZoom);
  expect(data.zoom).toBeGreaterThan(beforeZoom);

  const requestsBefore = observed.mapRequests.length;
  const panStart = performance.now();
  const moved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/map" && response.ok());
  await canvas(page).focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight", { delay: 10 });
  const panData = await (await moved).json() as MapResponse;
  await assertMapUI(page, panData);
  // Observe beyond the 250ms request debounce and Leaflet's pan animation for late bursts.
  await page.waitForTimeout(700);
  const rapidRequests = observed.mapRequests.length - requestsBefore;
  expect(rapidRequests).toBeGreaterThan(0);
  expect(rapidRequests).toBeLessThanOrEqual(2);
  metrics.rapidPan = { keyPresses: 6, requests: rapidRequests, observationMs: Math.round(performance.now() - panStart), debounceMs: 250 };

  await expect(page.getByLabel("Problem type").locator("option[value='Noise - Residential']")).toHaveCount(1);
  await mapAction(page, "complaint filter", () => page.getByLabel("Problem type").selectOption("Noise - Residential"), (url) => url.searchParams.get("problem") === "Noise - Residential");
  await mapAction(page, "start date filter", () => page.getByLabel("From", { exact: true }).fill("2026-08-05"), (url) => url.searchParams.get("from") === "2026-08-05");
  data = await mapAction(page, "end date filter", () => page.getByLabel("Through", { exact: true }).fill("2026-08-10"), (url) => url.searchParams.get("to") === "2026-08-10");
  expect(data.filters).toEqual({ from: "2026-08-05", to: "2026-08-10", problem: "Noise - Residential" });
  const pulse = await (await page.request.get("/api/pulse?from=2026-08-05&to=2026-08-10&problem=Noise%20-%20Residential")).json() as PulseResponse;
  await expect(page.locator(".metric-card").filter({ hasText: "Total requests" }).locator(".metric-value")).toHaveText(number.format(pulse.summary.total));
  expect(await page.locator("tbody .problem-cell strong").allTextContents()).toEqual(pulse.requests.map((row) => row.problem));
  await expect(page.getByRole("group", { name: "Daily request counts" }).getByRole("button")).toHaveCount(6);
  expect(data.visibleRequests).toBeLessThanOrEqual(pulse.summary.total - pulse.summary.missingCoordinates);
  await panel(page).screenshot({ path: "reports/portfolio/map-filtered.png", animations: "disabled" });

  data = await mapAction(page, "reset extent", () => panel(page).getByRole("button", { name: "Reset map to all boroughs" }).click());
  await expandList(page);
  for (let depth = 0; depth < 6 && data.mode !== "points" && data.zoom < 18; depth++) {
    const index = data.features.reduce((best, feature, i, all) => feature.count < all[best].count ? i : best, 0);
    const button = panel(page).locator(".map-accessible-list li button").nth(index);
    await button.focus();
    const oldZoom = data.zoom;
    data = await mapAction(page, "accessible list drilldown", () => page.keyboard.press("Enter"), (url) => Number(url.searchParams.get("zoom")) > oldZoom);
  }
  expect(data.mode).toBe("points");
  expect(data.zoom).toBeGreaterThanOrEqual(15);
  expect(data.features.length).toBeGreaterThan(0);
  const opener = panel(page).locator(".map-accessible-list li button").first();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = panel(page).getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await expect(dialog).toContainText(data.features[0].request!.id);
  await panel(page).screenshot({ path: "reports/portfolio/map-request-detail.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await panel(page).getByRole("button", { name: "Close request details" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(observed.outbound).toEqual([]);
  expect(observed.tileRequests.length).toBeGreaterThan(0);
  expect(observed.errors).toEqual([]);
  metrics.desktop = { viewport: { width: 1440, height: 1000 }, unexpectedOutboundRequests: observed.outbound, mockedTileRequests: observed.tileRequests.length, consoleErrors: observed.errors, mapRequests: observed.mapRequests.length, realDetailRequestId: data.features[0].request!.id };
});

test("mobile map contains its controls, geography, feature list, and horizontal layout", async ({ page }) => {
  const observed = monitor(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const data = await openMap(page);
  await expect(panel(page).getByRole("button", { name: "Zoom in", exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Zoom out", exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Reset map to all boroughs" })).toBeVisible();
  await expect(panel(page).locator(".map-borough-label")).toHaveCount(5);
  await expect(panel(page).locator(".map-canvas-frame")).toHaveClass(/map-streets-ready/);
  await expect(canvas(page)).toHaveClass(/leaflet-container/);
  await expect(panel(page).getByRole("link", { name: "OpenStreetMap", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await panel(page).screenshot({ path: "reports/portfolio/map-mobile.png", animations: "disabled" });
  await expandList(page);
  await expect(panel(page).locator(".map-accessible-list li button").first()).toBeVisible();
  await expect(panel(page).locator(".map-accessible-list li")).toHaveCount(data.features.length);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(observed.outbound).toEqual([]);
  expect(observed.tileRequests.length).toBeGreaterThan(0);
  expect(observed.errors).toEqual([]);
  metrics.mobile = { viewport: { width: 390, height: 844 }, featureCount: data.features.length, visibleRequests: data.visibleRequests, unexpectedOutboundRequests: observed.outbound, mockedTileRequests: observed.tileRequests.length, consoleErrors: observed.errors, documentOverflow: false };
});

test("slow street tiles do not block requests, and attribution stays visible when tiles load", async ({ page }) => {
  const gate = deferred();
  await page.route(STREET_TILE_PATTERN, async (route) => {
    await gate.promise;
    await fulfillStreetTile(route);
  });
  const data = await openMap(page);
  await expect(panel(page).locator(".map-basemap-status")).toContainText("Loading street map");
  await expect(panel(page).locator(".map-borough-label").first()).toBeVisible();
  expect(data.visibleRequests).toBeGreaterThan(0);
  gate.resolve();
  await expect(panel(page).locator(".map-canvas-frame")).toHaveClass(/map-streets-ready/);
  await expect(canvas(page)).toHaveClass(/leaflet-container/);
  await expect(panel(page).locator(".map-borough-label").first()).toBeHidden();
  await expect(panel(page).locator(".leaflet-streets-pane img.leaflet-tile-loaded").first()).toBeVisible();
  await expect(panel(page).getByRole("link", { name: "OpenStreetMap", exact: true })).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
  await assertMapUI(page, data);
});

test("street tile failure falls back without losing filters, details, or keyboard retry", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let failTiles = false;
  await page.route(STREET_TILE_PATTERN, (route) => failTiles ? route.abort() : fulfillStreetTile(route));
  await page.route("**/api/map?*", (route) => fulfillMap(route, "FALLBACK", 2));
  let data = await openMap(page);
  await expect(panel(page).locator(".map-canvas-frame")).toHaveClass(/map-streets-ready/);
  await expect(canvas(page)).toHaveClass(/leaflet-container/);
  failTiles = true;
  data = await mapAction(page, "tile failure while zooming", () => panel(page).getByRole("button", { name: "Zoom in", exact: true }).click());
  await expect(panel(page).locator(".map-basemap-status")).toContainText("Street map unavailable");
  await expect(panel(page).locator(".leaflet-streets-pane img")).toHaveCount(0);
  await expect(panel(page).locator(".map-borough-label").first()).toBeVisible();
  await assertMapUI(page, data);
  data = await mapAction(page, "filter with local fallback", () => page.getByLabel("Problem type").selectOption("Noise - Residential"));
  while (data.zoom < 15) data = await mapAction(page, "fallback detail zoom", () => panel(page).getByRole("button", { name: "Zoom in", exact: true }).click());
  await expandList(page);
  await panel(page).locator(".map-accessible-list li button").first().click();
  await expect(panel(page).getByRole("dialog")).toContainText("FALLBACK-0");
  await page.keyboard.press("Escape");
  failTiles = false;
  await panel(page).getByRole("button", { name: "Retry street map" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).locator(".map-canvas-frame")).toHaveClass(/map-streets-ready/);
  await expect(canvas(page)).toHaveClass(/leaflet-container/);
  await expect(panel(page).getByRole("button", { name: "Retry street map" })).toHaveCount(0);
  await assertMapUI(page, data);
  expect(errors).toEqual([]);
});

test("a stalled street tile request times out to local geography and can recover", async ({ page }) => {
  const gate = deferred();
  await page.route(STREET_TILE_PATTERN, async (route) => {
    await gate.promise;
    await fulfillStreetTile(route).catch(() => {});
  });
  const data = await openMap(page);
  await expect(panel(page).locator(".map-basemap-status")).toContainText("Street map unavailable", { timeout: 16_000 });
  await expect(panel(page).locator(".map-borough-label").first()).toBeVisible();
  await expect(panel(page).locator(".leaflet-streets-pane img")).toHaveCount(0);
  await assertMapUI(page, data);
  gate.resolve();
  await page.unroute(STREET_TILE_PATTERN);
  await page.route(STREET_TILE_PATTERN, fulfillStreetTile);
  await panel(page).getByRole("button", { name: "Retry street map" }).click();
  await expect(panel(page).locator(".map-canvas-frame")).toHaveClass(/map-streets-ready/);
  await expect(canvas(page)).toHaveClass(/leaflet-container/);
  await assertMapUI(page, data);
});

function mockedMap(urlString: string, label: string, amount = 17): MapResponse {
  const url = new URL(urlString);
  const bounds = ["west", "south", "east", "north"].map((key) => Number(url.searchParams.get(key))) as MapBounds;
  const zoom = Number(url.searchParams.get("zoom"));
  const longitude = (bounds[0] + bounds[2]) / 2;
  const latitude = (bounds[1] + bounds[3]) / 2;
  const filters = { from: url.searchParams.get("from") ?? "2026-08-01", to: url.searchParams.get("to") ?? "2026-08-31", problem: url.searchParams.get("problem") };
  const points = zoom >= 15;
  const features = amount === 0 ? [] : points ? Array.from({ length: Math.min(amount, 3) }, (_, i) => ({ id: `request:${label}-${i}`, longitude: longitude + i * 0.00001, latitude, count: 1, bounds: [longitude, latitude, longitude, latitude] as MapBounds, request: { id: `${label}-${i}`, createdAt: "2026-08-10T12:00:00.000000", closedAt: null, status: "Open", agency: "NYPD", problem: filters.problem ?? "Noise - Residential", detail: "Browser test request", borough: "MANHATTAN", qualityFlags: [] } })) : [{ id: `cell:${label}`, longitude, latitude, count: amount, bounds }];
  return { mode: points ? "points" : "grid", features, visibleRequests: features.reduce((sum, feature) => sum + feature.count, 0), cellSizeMeters: points ? null : 8192, bounds, zoom, filters, meta: { queryBounds: bounds, studyBounds: MAP_STUDY_BOUNDS, generatedAt: new Date().toISOString(), maxGridFeatures: MAX_GRID_FEATURES, maxPointFeatures: MAX_POINT_FEATURES } };
}

async function fulfillMap(route: Route, label: string, amount = 17) {
  await route.fulfill({ json: mockedMap(route.request().url(), label, amount) });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("map has explicit loading, empty, error, and retry states without losing dashboard totals", async ({ page }) => {
  const gate = deferred();
  let calls = 0;
  await page.route("**/api/map?*", async (route) => {
    calls++;
    if (calls === 1) { await gate.promise; await fulfillMap(route, "empty", 0); }
    else if (calls === 2) await route.fulfill({ status: 503, json: { error: { code: "DATA_UNAVAILABLE", message: "Map test: local database temporarily unavailable." } } });
    else await fulfillMap(route, "recovered", 42);
  });
  await page.goto("/");
  await panel(page).scrollIntoViewIfNeeded();
  await expect(panel(page).getByRole("status")).toContainText("Loading this area");
  await expect(panel(page).getByTestId("map-visible-count")).toHaveText("—");
  await expect(markers(page)).toHaveCount(0);
  await panel(page).screenshot({ path: "reports/portfolio/map-loading.png", animations: "disabled" });
  gate.resolve();
  await expect(panel(page).getByText("No requests in this area", { exact: true })).toBeVisible();
  await expect(panel(page).getByTestId("map-visible-count")).toHaveText("0");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await panel(page).screenshot({ path: "reports/portfolio/map-empty.png", animations: "disabled" });
  await panel(page).getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toContainText("Map test: local database temporarily unavailable.");
  await expect(markers(page)).toHaveCount(0);
  await panel(page).screenshot({ path: "reports/portfolio/map-error.png", animations: "disabled" });
  await panel(page).getByRole("button", { name: "Retry map data" }).click();
  await expect(panel(page).getByTestId("map-visible-count")).toHaveText("42");
  await expect(markers(page)).toHaveCount(1);
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
});

test("local geography failure offers a working retry", async ({ page }) => {
  let calls = 0;
  await page.route("**/map/boroughs.geojson", (route) => ++calls === 1 ? route.fulfill({ status: 503, body: "Unavailable" }) : route.continue());
  await page.goto("/");
  await panel(page).scrollIntoViewIfNeeded();
  await expect(panel(page).getByRole("alert")).toContainText("The borough map couldn’t load.");
  await expect(markers(page)).toHaveCount(0);
  await mapAction(page, "geography retry", () => panel(page).getByRole("button", { name: "Retry geography" }).click());
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
});

test("delayed filter responses cannot restore old counts, markers, list items, or request details", async ({ page }) => {
  test.setTimeout(90_000);
  const oldStarted = deferred();
  const releaseOld = deferred();
  const oldFinished = deferred();
  await page.route("**/api/map?*", async (route) => {
    const problem = new URL(route.request().url()).searchParams.get("problem");
    if (problem === "Noise - Residential") {
      oldStarted.resolve();
      await releaseOld.promise;
      try { await fulfillMap(route, "OLDER", 1); } finally { oldFinished.resolve(); }
    } else await fulfillMap(route, problem ? "LATEST" : "INITIAL", problem ? 2 : 1);
  });
  let data = await openMap(page);
  while (data.zoom < 15) data = await mapAction(page, "mock detail zoom", () => panel(page).getByRole("button", { name: "Zoom in", exact: true }).click());
  await expandList(page);
  await panel(page).locator(".map-accessible-list li button").first().click();
  await expect(panel(page).getByRole("dialog")).toContainText("INITIAL-0");
  await page.getByLabel("Problem type").selectOption("Noise - Residential");
  await oldStarted.promise;
  await expect(panel(page).getByTestId("map-visible-count")).toHaveText("—");
  await expect(markers(page)).toHaveCount(0);
  await expect(panel(page).getByRole("dialog")).toHaveCount(0);
  await expect(panel(page).locator(".map-accessible-list li")).toHaveCount(0);
  const latest = await mapAction(page, "newer mocked filter", () => page.getByLabel("Problem type").selectOption("Illegal Parking"), (url) => url.searchParams.get("problem") === "Illegal Parking");
  expect(latest.features[0].request!.id).toBe("LATEST-0");
  releaseOld.resolve();
  await oldFinished.promise;
  // Let the intentionally later obsolete response run through the browser event queue.
  await page.waitForTimeout(300);
  await assertMapUI(page, latest);
  await expect(panel(page).getByRole("dialog")).toHaveCount(0);
  await expect(panel(page).getByText(/OLDER|INITIAL-/)).toHaveCount(0);
  metrics.staleFilterProtection = "Passed: pending filter cleared all old features, list items, count and open details; obsolete response did not replace newer results.";
});

test("delayed pan responses cannot overwrite a newer viewport", async ({ page }) => {
  const oldStarted = deferred();
  const releaseOld = deferred();
  const oldFinished = deferred();
  let calls = 0;
  await page.route("**/api/map?*", async (route) => {
    calls++;
    if (calls === 2) {
      oldStarted.resolve();
      await releaseOld.promise;
      try { await fulfillMap(route, "OLDER-VIEW", 23); } finally { oldFinished.resolve(); }
    } else await fulfillMap(route, calls === 1 ? "INITIAL-VIEW" : "LATEST-VIEW", calls === 1 ? 17 : 41);
  });
  await openMap(page);
  await canvas(page).focus();
  await page.keyboard.press("ArrowRight");
  await oldStarted.promise;
  await expect(panel(page).getByTestId("map-visible-count")).toHaveText("—");
  await expect(markers(page)).toHaveCount(0);
  const latest = await mapAction(page, "newer mocked pan", () => page.keyboard.press("ArrowDown"));
  expect(latest.visibleRequests).toBe(41);
  releaseOld.resolve();
  await oldFinished.promise;
  await page.waitForTimeout(300);
  await assertMapUI(page, latest);
  await expect(markers(page).first()).toHaveAttribute("aria-label", /41 requests/);
  metrics.stalePanProtection = "Passed: stale viewport count and markers disappeared while pending; obsolete viewport response could not replace newer features/list.";
});
