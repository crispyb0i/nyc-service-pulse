import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';

const { values } = parseArgs({ options: { label: { type: 'string' } } });
assert.match(values.label ?? '', /^[a-z0-9][a-z0-9-]{0,39}$/, 'Supply --label before (or another lowercase report label).');
const output = `reports/readiness-${values.label}.json`;
await mkdir('reports', { recursive: true });
await access(output).then(() => { throw new Error(`${output} already exists; choose another label to preserve it.`); }, (error) => { if (error.code !== 'ENOENT') throw error; });
const base = 'http://127.0.0.1:3100';
const runs = [];

// Runs before application JavaScript. Observe the app's own body consumption: no
// cloned responses, duplicate JSON parsing, additional requests, or app changes.
function installProbe() {
  const state = { timeOrigin: performance.timeOrigin, milestones: {}, fetches: [], dom: null };
  window.__pulseReadiness = state;
  performance.setResourceTimingBufferSize(2000);
  const mark = (name) => { if (state.milestones[name] === undefined) state.milestones[name] = performance.now(); };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!/^\/api\/(pulse|problems|map)$/.test(url.pathname) && !/^\/map\/.*\.geojson$/.test(url.pathname)) return nativeFetch(input, init);
    const record = { url: url.pathname + url.search, path: url.pathname, startMs: performance.now() };
    state.fetches.push(record);
    if (url.pathname.startsWith('/api/')) mark('firstDataFetchMs');
    try {
      const response = await nativeFetch(input, init);
      record.headersMs = performance.now();
      record.status = response.status;
      record.serverTiming = response.headers.get('server-timing');
      const nativeJson = response.json.bind(response);
      response.json = async () => {
        record.jsonStartedMs = performance.now();
        try {
          const body = await nativeJson();
          record.jsonParsedMs = performance.now();
          if (url.pathname === '/api/map' && Array.isArray(body.features)) {
            record.summary = { visibleRequests: body.visibleRequests, featureCount: body.features.length,
              featureCountSum: body.features.reduce((sum, item) => sum + item.count, 0),
              uniqueFeatures: new Set(body.features.map((item) => item.id)).size,
              mode: body.mode, zoom: body.zoom, bounds: body.bounds, filters: body.filters };
          } else if (url.pathname === '/api/pulse' && body.summary) {
            record.summary = { total: body.summary.total, missingCoordinates: body.summary.missingCoordinates,
              dailyCountSum: body.daily.reduce((sum, day) => sum + day.count, 0), rows: body.requests.length, filters: body.meta.filters };
          } else if (Array.isArray(body.features)) record.summary = { features: body.features.length };
          else if (Array.isArray(body.problems)) record.summary = { problems: body.problems.length };
          return body;
        } catch (error) { record.jsonError = String(error); throw error; }
      };
      return response;
    } catch (error) { record.failedMs = performance.now(); record.error = String(error); throw error; }
  };

  let observedPanel = false;
  let checkingFrames = false;
  const readMap = () => {
    const panel = document.getElementById('map');
    if (!panel) return null;
    return { visibleCount: Number(panel.querySelector('[data-testid="map-visible-count"]')?.textContent.replaceAll(',', '')),
      markerCount: panel.querySelectorAll('.map-request-cluster, .map-request-point').length,
      listCount: panel.querySelectorAll('.map-accessible-list li').length,
      stale: Boolean(panel.querySelector('.map-stale')) };
  };
  const scan = () => {
    const panel = document.getElementById('map');
    if (!panel) return;
    mark('mapMountedMs');
    if (!observedPanel) {
      observedPanel = true;
      // Independent observer with the app's 200px margin: a proximity proxy,
      // not an assertion about React's internal effect/state timing.
      const nearby = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { mark('mapNearbyObservedMs'); nearby.disconnect(); }
      }, { rootMargin: '200px' });
      nearby.observe(panel);
    }
    if (panel.querySelector('.leaflet-container')) mark('leafletInitializedMs');
    const current = readMap();
    if (current.markerCount > 0) mark('firstMapMarkersMs');
    if (!(current.visibleCount > 0 && current.markerCount > 0 && !current.stale) || checkingFrames) return;
    mark('firstPositiveMapCountAndMarkersMs');
    checkingFrames = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const settled = readMap();
      checkingFrames = false;
      if (settled?.visibleCount === current.visibleCount && settled.markerCount === current.markerCount && settled.listCount === current.listCount && !settled.stale) {
        state.dom = settled;
        mark('mapReadyAfterTwoFramesMs');
        mutations.disconnect();
      } else scan();
    }));
  };
  const mutations = new MutationObserver(scan);
  mutations.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  scan();
}

function collectProbe() {
  const serialize = (entry) => ({ ...entry.toJSON(), serverTiming: Array.from(entry.serverTiming ?? [], (timing) => ({ name: timing.name, duration: timing.duration, description: timing.description })) });
  const elapsed = (end, start) => typeof end === 'number' && typeof start === 'number' ? end - start : null;
  const fetches = window.__pulseReadiness.fetches.map((record) => ({ ...record, intervalsMs: {
    startToHeaders: elapsed(record.headersMs, record.startMs),
    headersToJsonStarted: elapsed(record.jsonStartedMs, record.headersMs),
    bodyReadAndJsonParse: elapsed(record.jsonParsedMs, record.jsonStartedMs),
    headersToJsonParsed: elapsed(record.jsonParsedMs, record.headersMs),
  } }));
  return { ...window.__pulseReadiness, fetches, collectedMs: performance.now(),
    navigation: performance.getEntriesByType('navigation').map(serialize),
    resources: performance.getEntriesByType('resource').map(serialize),
    paints: performance.getEntriesByType('paint').map((entry) => entry.toJSON()) };
}

function intervals(probe) {
  if (!probe?.milestones) return null;
  const timeline = probe.milestones;
  const navigation = probe.navigation[0];
  const map = probe.fetches.find((item) => item.path === '/api/map' && item.jsonParsedMs !== undefined);
  const difference = (end, start) => typeof end === 'number' && typeof start === 'number' ? end - start : null;
  return {
    documentTtfbMs: difference(navigation?.responseStart, navigation?.requestStart),
    navigationToDocumentFirstByteMs: navigation?.responseStart ?? null,
    documentResponseEndMs: navigation?.responseEnd ?? null,
    documentTransferMs: difference(navigation?.responseEnd, navigation?.responseStart),
    documentResponseEndToFirstDataFetchMs: difference(timeline.firstDataFetchMs, navigation?.responseEnd),
    firstDataFetchToMapMountedMs: difference(timeline.mapMountedMs, timeline.firstDataFetchMs),
    mapMountedToNearbyObservedMs: difference(timeline.mapNearbyObservedMs, timeline.mapMountedMs),
    nearbyObservedToLeafletInitializedMs: difference(timeline.leafletInitializedMs, timeline.mapNearbyObservedMs),
    leafletInitializedToMapFetchMs: difference(map?.startMs, timeline.leafletInitializedMs),
    mapFetchToHeadersMs: difference(map?.headersMs, map?.startMs),
    mapHeadersToJsonParsedMs: difference(map?.jsonParsedMs, map?.headersMs),
    mapJsonParsedToFirstMarkersMs: difference(timeline.firstMapMarkersMs, map?.jsonParsedMs),
    firstMarkersToReadyAfterTwoFramesMs: difference(timeline.mapReadyAfterTwoFramesMs, timeline.firstMapMarkersMs),
    navigationToMapReadyMs: timeline.mapReadyAfterTwoFramesMs ?? null,
  };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failure;
try {
  for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    for (let sample = 1; sample <= 5; sample++) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      const errors = [];
      const externalRequests = [];
      const nodeStart = performance.now();
      const nodeStepsMs = {};
      const step = (name) => { nodeStepsMs[name] = performance.now() - nodeStart; };
      const result = { device, sample, viewport, nodeStepsMs, errors, externalRequests };
      runs.push(result);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) externalRequests.push(request.url());
      });
      try {
        await page.addInitScript(installProbe);
        step('gotoStarted');
        await page.goto(`${base}/`);
        step('gotoReturned');
        step('scrollStarted');
        await page.locator('#map').scrollIntoViewIfNeeded();
        step('scrollReturned');
        await page.waitForFunction(() => window.__pulseReadiness?.milestones.mapReadyAfterTwoFramesMs !== undefined, null, { timeout: 60_000 });
        step('browserReadyObserved');
        step('assertionsStarted');
        result.probe = await page.evaluate(collectProbe);
        const map = result.probe.fetches.filter((item) => item.path === '/api/map' && item.summary).at(-1).summary;
        const pulse = result.probe.fetches.filter((item) => item.path === '/api/pulse' && item.summary).at(-1).summary;
        assert.equal(map.featureCountSum, map.visibleRequests);
        assert.equal(map.uniqueFeatures, map.featureCount);
        assert.equal(pulse.dailyCountSum, pulse.total);
        assert.deepEqual(map.filters, pulse.filters);
        assert.ok(map.visibleRequests <= pulse.total - pulse.missingCoordinates);
        assert.ok(map.featureCount <= (map.mode === 'points' ? 100 : 400));
        await expect(page.locator('#map').getByTestId('map-visible-count')).toHaveText(new Intl.NumberFormat('en-US').format(map.visibleRequests));
        await expect(page.locator('#map .map-request-cluster, #map .map-request-point')).toHaveCount(map.featureCount);
        await expect(page.locator('#map .map-accessible-list li')).toHaveCount(map.featureCount);
        await expect(page.locator('#map .map-stale')).toHaveCount(0);
        assert.deepEqual(errors, []);
        assert.deepEqual(externalRequests, []);
        step('nodeAssertionsSettled');
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        step('nodeAssertionsAndTwoFramesSettled');
        result.probe = await page.evaluate(collectProbe);
        result.intervalsMs = intervals(result.probe);
        result.status = 'passed';
      } catch (error) {
        result.status = 'failed';
        result.error = String(error);
        result.probe = await page.evaluate(collectProbe).catch(() => null);
        result.intervalsMs = intervals(result.probe);
        throw error;
      } finally { await context.close(); }
    }
  }
} catch (error) { failure = error; }
finally { await browser.close(); }

const report = {
  label: values.label, measuredAt: new Date().toISOString(), base, status: failure ? 'failed' : 'passed',
  method: {
    samples: 'Five desktop then five mobile runs, sequential fresh ephemeral contexts in one installed Chrome process.',
    serverState: 'Caller controls production restarts. This script does not reset server/database caches or issue extra API requests.',
    browserClock: 'Browser timestamps are performance.now() milliseconds relative to navigation timeOrigin; Node steps use a separate per-run monotonic clock.',
    firstDataFetch: 'Proxy for client effects becoming ready after JavaScript loading and hydration/effect scheduling; not pure hydration time.',
    mapReady: 'First positive visible map count and markers, unchanged through two animation frames; DOM observation, not FPS or a paint guarantee.',
    nodeSettlement: 'Locator/count assertions and their following two frames are recorded separately from browser DOM readiness.',
    serverTiming: 'API data duration includes parameter parsing, pool acquisition, transaction and SQL; it is not pure database execution time.',
    overhead: 'Fetch wrappers, mutation/intersection observers and browser automation add measurement overhead. JSON bodies are consumed once by the app; only count/filter summaries are retained.',
  },
  runs,
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, status: report.status, runs: runs.map((run) => ({ device: run.device, sample: run.sample, status: run.status, navigationToMapReadyMs: run.intervalsMs?.navigationToMapReadyMs, nodeAssertionsAndTwoFramesSettledMs: run.nodeStepsMs.nodeAssertionsAndTwoFramesSettled })) }, null, 2));
if (failure) throw failure;
