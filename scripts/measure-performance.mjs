import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';

const { values } = parseArgs({ options: { label: { type: 'string' }, samples: { type: 'string', default: '3' }, trace: { type: 'boolean', default: false } } });
assert.match(values.label ?? '', /^[a-z0-9][a-z0-9-]{0,39}$/);
const samples = Number(values.samples);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 10);
const directory = `reports/portfolio/${values.label}`;
await access(directory).then(() => { throw new Error('Report exists; choose a new label.'); }, (error) => { if (error.code !== 'ENOENT') throw error; });
await mkdir(directory, { recursive: true });
const base = process.env.PULSE_TEST_URL ?? 'http://127.0.0.1:3100';

function installProbe() {
  const probe = { events: [], longTasks: [], longFrames: [], shifts: [], frames: [], recording: false };
  window.__pulsePerformance = probe;
  for (const [type, key] of [['event', 'events'], ['longtask', 'longTasks'], ['long-animation-frame', 'longFrames'], ['layout-shift', 'shifts']]) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
    new PerformanceObserver((list) => {
      for (const item of list.getEntries()) {
        if (probe[key].length < 3000) probe[key].push({ start: item.startTime, duration: item.duration, interactionId: item.interactionId, value: item.value, recentInput: item.hadRecentInput });
      }
    }).observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) });
  }
  let previous;
  const frame = (now) => {
    if (probe.recording && previous !== undefined && probe.frames.length < 10000) probe.frames.push(now - previous);
    previous = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const percentile = (items, p) => items.length ? [...items].sort((a, b) => a - b)[Math.min(items.length - 1, Math.ceil(items.length * p) - 1)] : null;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? 'chrome', headless: true });
const runs = [];
let failure;
try {
  for (const profile of [
    { name: 'desktop', viewport: { width: 1440, height: 1000 }, cpu: 1, latency: 0 },
    { name: 'constrained-mobile', viewport: { width: 390, height: 844 }, cpu: 4, latency: 100 },
  ]) {
    for (let sample = 1; sample <= samples; sample++) {
      const context = await browser.newContext({ viewport: profile.viewport, reducedMotion: 'reduce' });
      // Deterministic basemap; never run a public tile crawler as a benchmark.
      await context.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf0e8"/></svg>' }));
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: profile.latency ? 200_000 : -1, uploadThroughput: profile.latency ? 93_750 : -1 });
      const errors = [];
      const api = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) api.push({ path: url.pathname, at: performance.now() }); });
      await page.addInitScript(installProbe);
      const run = { profile: profile.name, sample, conditions: profile, loads: [], interactions: [], errors };
      runs.push(run);
      const recordTrace = values.trace && sample === 1 && profile.name === 'desktop';
      if (recordTrace) await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
      try {
        for (const temperature of ['cold-browser', 'warm-browser']) {
          const start = performance.now();
          const mapResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/map' && response.ok());
          await page.goto(`${base}/`);
          await page.locator('#map').scrollIntoViewIfNeeded();
          const map = await (await mapResponse).json();
          await expect(page.getByTestId('map-visible-count')).toHaveText(new Intl.NumberFormat('en-US').format(map.visibleRequests));
          await expect(page.locator('#map .map-stale')).toHaveCount(0);
          await expect(page.getByLabel('Problem type').locator('option[value="Illegal Parking"]')).toHaveCount(1);
          await expect(page.locator('tbody tr')).toHaveCount(50);
          run.loads.push({ temperature, settledMs: performance.now() - start, resources: await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.includes('/api/') || r.initiatorType === 'script').map((r) => ({ path: new URL(r.name).pathname, startMs: r.startTime, durationMs: r.duration, transferBytes: r.transferSize, decodedBytes: r.decodedBodySize }))) });
        }
        await page.evaluate(() => { window.__pulsePerformance.recording = true; });
        const heapBefore = await cdp.send('Runtime.getHeapUsage');
        for (let turn = 0; turn < 5; turn++) {
          const first = await page.locator('tbody .request-id').first().textContent();
          const beforeRequests = api.length;
          const start = performance.now();
          await page.getByRole('button', { name: 'Next page', exact: true }).click();
          await expect(page.locator('tbody .request-id').first()).not.toHaveText(first);
          await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
          run.interactions.push({ action: 'next-page', settledMs: performance.now() - start, apiRequests: api.slice(beforeRequests).map((r) => r.path) });
        }
        await page.locator('#map').scrollIntoViewIfNeeded();
        await page.getByRole('region', { name: 'NYC service request map. Use arrow keys to pan, plus and minus to zoom.' }).focus();
        const panStart = performance.now();
        const beforePan = api.length;
        const pan = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/map' && response.ok());
        for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight', { delay: 10 });
        const panData = await (await pan).json();
        await expect(page.getByTestId('map-visible-count')).toHaveText(new Intl.NumberFormat('en-US').format(panData.visibleRequests));
        run.interactions.push({ action: 'six-key-pan', settledMs: performance.now() - panStart, apiRequests: api.slice(beforePan).map((r) => r.path) });
        const filterStart = performance.now();
        const filtered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/pulse' && new URL(response.url()).searchParams.get('problem') === 'Illegal Parking' && response.ok());
        await page.getByLabel('Problem type').selectOption('Noise - Residential');
        await page.getByLabel('Problem type').selectOption('Illegal Parking');
        const data = await (await filtered).json();
        await expect(page.locator('.metric-card').filter({ hasText: 'Total requests' }).locator('.metric-value')).toHaveText(new Intl.NumberFormat('en-US').format(data.summary.total));
        await expect(page.locator('tbody tr')).toHaveCount(50);
        run.interactions.push({ action: 'rapid-filter', settledMs: performance.now() - filterStart });
        run.heapBeforeBytes = heapBefore.usedSize;
        run.heapAfterBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize;
        run.dom = await cdp.send('Memory.getDOMCounters');
        run.probe = await page.evaluate(() => { window.__pulsePerformance.recording = false; return window.__pulsePerformance; });
        run.summary = { nextPageMedianMs: percentile(run.interactions.filter((i) => i.action === 'next-page').map((i) => i.settledMs), .5), eventDurationP95Ms: percentile(run.probe.events.filter((e) => e.interactionId).map((e) => e.duration), .95), observedLongTasks: run.probe.longTasks.length, observedLongFrames: run.probe.longFrames.length, frameIntervalP95Ms: percentile(run.probe.frames, .95), cls: run.probe.shifts.filter((s) => !s.recentInput).reduce((sum, s) => sum + s.value, 0) };
        assert.deepEqual(errors, []);
        run.status = 'passed';
      } catch (error) { run.status = 'failed'; run.error = String(error); throw error; }
      finally {
        if (recordTrace) {
          const completed = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
          await cdp.send('Tracing.end');
          const { stream } = await completed;
          let trace = '';
          for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); trace += chunk.data; if (chunk.eof) break; }
          await cdp.send('IO.close', { handle: stream });
          await writeFile(`${directory}/chrome-trace.json`, trace, { flag: 'wx' });
        }
        await context.close();
      }
    }
  }
} catch (error) { failure = error; }
finally { await browser.close(); }
const report = { label: values.label, measuredAt: new Date().toISOString(), status: failure ? 'failed' : 'passed', method: { samplesPerProfile: samples, tileSource: 'Synthetic intercepted tiles; live local APIs', cache: 'Cold and warm browser loads in each fresh context. Database/server caches are not reset.', timing: 'Settlement includes Playwright dispatch/assertions. Event Timing is quantized and excludes events below 16 ms; not field INP. rAF intervals are scheduling observations, not measured presented frames or an FPS guarantee.', memory: 'Observed JS heap without forced GC; difference is not proof of retained-memory growth. DOM counters can include detached nodes pending GC.', mobile: 'Desktop Chrome with a mobile viewport, 4x CPU slowdown, 100ms latency, 1.6Mbps download/0.75Mbps upload; not a physical phone.', instrumentation: 'Observers, rAF sampling, optional trace and automation add overhead. Keep conditions fixed across comparisons.' }, runs };
await writeFile(`${directory}/performance.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, status: report.status, runs: runs.map(({ profile, sample, status, summary }) => ({ profile, sample, status, summary })) }, null, 2));
if (failure) throw failure;
