import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';

const { values } = parseArgs({ options: { label: { type: 'string' } } });
assert.match(values.label ?? '', /^[a-z0-9][a-z0-9-]{0,39}$/);
const directory = `reports/portfolio/${values.label}`;
await access(directory).then(() => { throw new Error('Report exists; choose another label.'); }, (error) => { if (error.code !== 'ENOENT') throw error; });
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? 'chrome', headless: true });
const report = { capturedAt: new Date().toISOString(), method: 'Real API, mocked street tiles, desktop Chromium. 30 sequential scroll-to-bottom gestures load 1,550 records. Heap sampled after explicit CDP garbage collection at successive bounded windows; these samples cannot prove absence of leaks. DOM/cache caps are enforced; machine-dependent timing is reported separately.', budgets: { cachedPages: 8, cachedRows: 400, mountedRows: 20, pageBodyBytes: 50_000 }, windows: [], pages: [], errors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>' }));
  page.on('pageerror', (error) => report.errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  await page.goto(process.env.PULSE_TEST_URL ?? 'http://127.0.0.1:3100');
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await page.getByRole('button', { name: 'Continuous list', exact: true }).click();
  const scroll = page.getByRole('region', { name: 'Continuous service requests', exact: true });
  await expect(scroll.locator('li').first()).toBeVisible();
  for (let turn = 0; turn <= 30; turn++) {
    if (turn) {
      const pending = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/requests' && response.ok());
      const start = performance.now();
      await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const response = await pending;
      const body = await response.body();
      await expect(page.locator('.explorer-feedback')).not.toContainText('Loading');
      report.pages.push({ turn, settledMs: performance.now() - start, bodyBytes: body.byteLength });
      assert.ok(body.byteLength <= report.budgets.pageBodyBytes);
    }
    const cachedPages = Number(await page.locator('#requests').getAttribute('data-cached-pages'));
    const cachedRows = Number(await page.locator('#requests').getAttribute('data-cached-rows'));
    const mountedRows = await scroll.locator('li').count();
    assert.ok(cachedPages <= 8 && cachedRows <= 400 && mountedRows <= 20);
    if ([0,7,15,23,30].includes(turn)) {
      await cdp.send('HeapProfiler.collectGarbage');
      const heap = await cdp.send('Runtime.getHeapUsage');
      const dom = await cdp.send('Memory.getDOMCounters');
      report.windows.push({ recordsTraversed: (turn + 1) * 50, cachedPages, cachedRows, mountedRows, heapUsedBytesAfterGC: heap.usedSize, dom });
    }
  }
  assert.deepEqual(report.errors, []);
  await page.screenshot({ path: `${directory}/continuous-list.png`, fullPage: true });
} catch (error) { report.failure = String(error); throw error; }
finally { await writeFile(`${directory}/window.json`, JSON.stringify(report, null, 2) + '\n'); await browser.close(); }
console.log(JSON.stringify(report.windows, null, 2));
