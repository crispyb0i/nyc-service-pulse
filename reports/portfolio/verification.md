# Portfolio verification

- `npm run typecheck`: passed.
- `npm run lint`: exit 0; one retained TanStack Virtual / React Compiler compatibility warning. React Compiler is not enabled.
- `npm test`: 24 passed; five database tests skipped without TEST_DATABASE_URL.
- `TEST_DATABASE_URL=<local database> npm run test:db`: five real PostgreSQL/PostGIS tests passed. Test fixtures use temporary tables and owned sessions; no imported records were modified.
- `npm run build`: passed.
- `npm run test:ui`: 29 passed on the final build; report is ui-results.json. Earlier failed attempts are preserved in attempt-1, attempt-2 and attempt-3, with explanations.
- `npm run measure:performance -- --label before --samples 3 --trace`: six runs passed.
- `npm run measure:performance -- --label after --samples 3 --trace`: six runs passed; revealed a layout-shift regression, retained for transparency.
- `npm run measure:window -- --label window`: passed; 1,550 records traversed, at most 400 cached and 14 mounted in sampled windows.
- `node --input-type=module` CLS reducer assertion: session-window reset and recent-input exclusion passed.
- Cloud migration: new empty Neon database restored, row/geocode counts matched, planner statistics refreshed, read-only role SELECT succeeded and no-op UPDATE was denied.
- Deployment: initial project preset was Other and returned 404 despite a successful build. Explicit Next.js configuration corrected routing; subsequent public HTTP smoke checks passed (deployed-smoke.json).
- `git diff --cached --check -- . ':!reports'`: passed. Original raw terminal reports retain carriage returns/trailing whitespace and were preserved verbatim.
- Manual Chrome: real OpenStreetMap tiles visually inspected; no console errors or horizontal overflow on desktop. Automated browser checks use synthetic tiles.

Timings are lab observations. See the case study for conditions, comparability limits and the retained intermediate reports.

- `npm run measure:performance -- --label after-stable-layout --samples 3 --trace`: six final runs passed.
- `node scripts/compare-performance.mjs`: passed; recomputes windowed CLS from raw events for both versions.
- `npm run measure:readiness -- --label portfolio`: ten loads passed.
- Measurement errata: intercepted routing disables HTTP cache. Cold/warm labels represent fresh/repeated navigation, not network-cache misses/hits. Older raw `cls` summaries summed shifts; final comparisons use the correct largest session window.

- Final detail contrast refinement: `npm run typecheck`, `npm run lint`, and `npm run build` passed; `npx playwright test tests/explorer-ui.spec.ts --grep "automated WCAG" --reporter=line` passed with the detail dialog included at both widths.
- Public Chrome check: 328,892 records, no page overflow at 390 px, continuous mode rendered 10 rows from 50 cached, no console errors, and real street/building tiles visible with a linked request selected.

- Initial GitHub CI runs [36972392306](https://github.com/crispyb0i/nyc-service-pulse/actions/runs/36972392306) and [36972679414](https://github.com/crispyb0i/nyc-service-pulse/actions/runs/36972679414) exposed redundant initial map fetches. Leaflet reported identical bounds with a new object, cancelling an in-flight request. The viewport now retains its identity when bounds and zoom are unchanged.
- `npx playwright test tests/map-ui.spec.ts --grep "unchanged viewport" --reporter=line`: failed before the fix (two requests instead of one), passed after it. The test holds the first response, resets the already fitted map, and verifies one request with no abort before releasing the response.
- Post-fix `npm run typecheck`, `npm run build`, and `npm run lint`: passed; lint retains the one documented warning. `npm test`: 24 passed, five DB tests skipped. `npm run test:db` with the local database loaded from `.env.local`: five passed. `npm run test:ui`: all 29 passed in 1.9 minutes.
- Performance timings belong to the preserved `portfolio-after` tag. The contrast and unchanged-viewport corrections were checked separately; the timing series was not rerun after them.

## Scroll-to-zoom follow-up

- `npm run typecheck` and `npm run build`: passed.
- `npm run lint`: passed with the existing TanStack Virtual warning.
- `npm test`: 24 passed; five database tests skipped without `TEST_DATABASE_URL`.
- `npx playwright test tests/map-ui.spec.ts --grep "desktop map shares|mobile map contains" --reporter=line --output=/tmp/nyc-pulse-scroll-zoom-test`: mobile passed; desktop received an initial map API 503 and timed out. The local database logged a statement timeout; subsequent health/map requests recovered without a code or timeout change.
- `npx playwright test tests/map-ui.spec.ts --grep "desktop map shares" --reporter=line --output=/tmp/nyc-pulse-scroll-zoom-retry`: passed on retry, including keyboard pan/zoom, filtering, request details and focus return.
- Chrome DOM wheel-event checks: zoom changed 10 → 10.5 → 10 while page position stayed at 646 px; wheel input outside the canvas was not cancelled. A separate page scroll moved to 885 px without changing map zoom. These were browser event checks, not a physical mouse or trackpad test.
