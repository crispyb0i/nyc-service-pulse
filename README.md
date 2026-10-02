# NYC Service Pulse

A local civic-data observatory for **NYC 311 requests created during August 2026**. One shared complaint/date filter drives the summary, daily chart, interactive map, and cursor-paginated request table. Built with Next.js App Router, React, TypeScript, PostgreSQL, and PostGIS.

## Run locally

```sh
cd /Users/david/developer/nyc-service-pulse
npm ci
cp .env.example .env.local  # only on a fresh setup; preserve an existing .env.local
npm run db:up
npm run db:migrate
npm run import:august
npm run dev
```

The import and build are already complete on this Mac. For a later restart, start the database with `npm run db:up`, then use `npm start` for the saved production build or `npm run dev` for editing. No re-import is required to view the existing snapshot.

Open **http://127.0.0.1:3100**. Database: `127.0.0.1:54329`, database name `nyc_service_pulse`. No NYC API account, token, or cloud service is required.

For a production-mode local preview:

```sh
npm run build
npm start
```

Stop the app with Ctrl-C and the project database with `npm run db:stop`. `docker compose stop` retains data. The Compose project `nyc-service-pulse` has its own `pulse_pgdata` volume. Existing databases and containers are not used. The database is bound only to localhost; its example password is deliberately local-development-only. No remote is configured and nothing is deployed.

## Source and interpretation

- [NYC Open Data 311 API](https://data.cityofnewyork.us/resource/erm2-nwe9.json), dataset `erm2-nwe9`, which currently includes 2020 onward.
- Cohort: `created_date >= '2026-08-01T00:00:00' AND created_date < '2026-09-01T00:00:00'`.
- The publisher's **Problem** and **Problem Detail** labels are API fields `complaint_type` and `descriptor`.
- Created and closed dates are source floating timestamps. They are stored as `timestamp without time zone`, with original strings retained. The interface uses a publisher-local New York display assumption; this is not a verified timezone assertion and no UTC offset is invented. System `:updated_at` is a fixed timestamp and is stored as an instant.
- "Closed" counts source status, not verified problem resolution or resident satisfaction. Median closure includes only Closed records with a nonnegative, valid created-to-closed interval. Records with anomalous dates remain visible with quality flags.
- Missing coordinates remain in all totals and table results. The map excludes records without usable coordinates and limits spatial queries to its documented NYC study envelope; neither exclusion changes the chart, summary, or table.
- NYC's source is mutable. Counts are measured snapshots, never hardcoded expectations. This is a complete month of requests, not a real-time feed or citywide population-normalized rate.

## Architecture and bounded data flow

The browser receives daily aggregates and **50 requests**, never the entire cohort. `/api/pulse` reads the summary, chart, rows, and provenance in one repeatable-read transaction. The exact same parameterized date/complaint predicate is reused. Inclusive UI dates become an exclusive next-day SQL boundary. Pagination orders by `(created_at DESC, id DESC)`; the opaque cursor is tied to its filter set and preserves timestamp microseconds. The B-tree indexes match this ordering and the complaint/date path. Two small timestamp indexes make freshness metadata a pair of index lookups; calendar-day expression statistics inform chart aggregation. Connections use 16 MB work memory to avoid measured median-sort spills, scoped to the five-connection app pool.

Endpoints:

- `GET /api/pulse?from=2026-08-01&to=2026-08-31&problem=Noise%20-%20Residential`
- `GET /api/pulse?...&cursor=<nextCursor>`
- `GET /api/problems?from=2026-08-01&to=2026-08-31`
- `GET /api/map?west=-74.6&south=40.3&east=-73.4&north=41.15&zoom=10.5&from=2026-08-01&to=2026-08-31`
- `GET /api/health`

Invalid filters return 400. Database unavailability returns a structured 503 without connection details. Empty selections return 200 with zero daily counts and an empty page. The UI distinguishes initial loading, filter updates, empty results, and retryable failures.

## Interactive map

Leaflet loads only when the map approaches the viewport. An OpenStreetMap street basemap shows roads, street names, parks, and building footprints as you zoom in. Its colors are subdued beneath the green request markers. Local NYC Department of City Planning borough outlines and optional close-up neighborhood statistical-area names remain available underneath; local labels hide when the street map is ready to avoid duplicates. Pan, use the zoom/reset controls, or focus the map and use arrow keys and +/−. Every displayed area or individual request also appears in the expandable native HTML list. Individual details close with Escape and restore focus. Co-located requests can overlap visually; their separate IDs remain accessible in the list.

Street tiles load independently of request data. A failed tile or a tile batch taking more than 12 seconds switches to the local geography with a keyboard-accessible **Retry street map** button. Counts, filters, pan/zoom, the list, and request details continue to work during a tile outage. Grouped positions remain area averages, not building locations, and detailed map geometry does not increase the precision of the original 311 coordinates.

The browser requests visible raster tiles directly from `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, using normal HTTP caching and an origin-only cross-origin referrer. Request records and filter parameters are not sent to the tile provider. OpenStreetMap attribution remains visible inside the map. This local preview uses the public service under its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/); no key, account, proxy, bulk downloads, or new package is required. Availability is best effort. Revisit the provider before a high-traffic deployment. Browser regressions use synthetic tile images and simulated failures; real map appearance requires a separate visual check.

`/api/map` accepts the same `from`, `to`, and `problem` parameters as the dashboard, plus WGS84 `west`, `south`, `east`, `north`, and `zoom`. The server clips spatial queries to `[-74.6, 40.3, -73.4, 41.15]`, uses a partial GiST index, and checks exact point coordinates after index selection. A globally anchored Web Mercator grid adapts to viewport size and zoom, returning **at most 400 cells** without dropping counts. At zoom 15 or greater, **at most 100 individual requests** are returned only if the entire visible selection fits; dense selections remain aggregated. Group positions are average request coordinates within each cell, not an address. Grid dimensions are projected meters, not ground-distance measurements.

Map queries use the shared parameterized complaint/date predicate and their own repeatable-read transaction. The map reports the visible subset; the chart and table continue to report the full filtered cohort. The current imported snapshot has **322,590 usable-coordinate records**, all inside the study envelope, and **6,302 missing-coordinate records** retained elsewhere. Map and dashboard are separate HTTP snapshots; a manual import running concurrently could briefly produce differing freshness.

Client requests debounce by 250 ms and abort on filter or viewport changes. Generation and query-key checks prevent delayed results from restoring stale counts, markers, lists, or details. Map loading, no matches, data failure, and geography failure have distinct states; failures offer retry. Marker Tab stops are replaced by the complete accessible list so keyboard users do not traverse hundreds of map objects. No FPS or assistive-technology certification is claimed.

The spatial index adds **13,557,760 bytes**. Profiling exposed expensive LLVM JIT compilation and geometry-key sorting under local Docker emulation. Map transactions disable JIT locally and group integer grid keys using the EPSG:3857 formula; an integration assertion checks it against PostGIS projection. There are no precomputed projection columns, rollups, or result caches. See [before-query plans](reports/map-query-profile-before.json) and [implementation profile](reports/map-query-profile.json).

### Geography provenance

The bundled geography comes from NYC DCP's public [Borough Boundaries](https://www.nyc.gov/content/planning/pages/resources/datasets/borough-boundaries) and [Neighborhood Tabulation Areas](https://www.nyc.gov/content/planning/pages/resources/datasets/neighborhood-tabulation) datasets, served through NYC Open Data IDs `gthc-hcne` and `9nt8-h7nd`. The downloaded versions were **26b** (May 2026), even though a newer version may be advertised elsewhere. Attribution appears on the map; [NYC terms](https://www.nyc.gov/main/terms-of-use) apply. The metadata did not specify a separate license, so no CC0 claim is made.

Borough geometry was simplified with topology preservation at 45 US survey feet (~13.7 m) in EPSG:2263, then converted to WGS84 with 7-decimal coordinate precision. All 117 polygon components remain; the largest measured borough area change is 0.042%. These are geographic context outlines, not survey or street-level boundaries. The 197 residential NTA labels use points on their original polygons. NTA names describe statistical areas, not definitive neighborhood boundaries.

The three local fallback assets total about 220 KB before compression and need no external network access. Service-request data stays on localhost; the street basemap separately requests public OpenStreetMap tiles. Source versions, fetch times, hashes, bounds, geometry checks, and exact sizes for the local assets are recorded in [geography-source.json](reports/geography-source.json). Regenerate deliberately with `npm run map:prepare` while the project database is running; it makes four bounded public downloads and read-only PostGIS queries.

## Import and refresh

`npm run import:august` is restartable. Re-run it after an interruption. It requests only the August cohort in sequential daily windows, selects focused fields, and uses stable request-ID keyset pages of at most 5,000. Source requests have timeouts, throttling, and bounded retry/backoff. Daily source ID bounds avoid a costly first-page scan over unrelated history.

Each committed batch upserts by text request ID together with its checkpoint; interruption cannot advance a checkpoint past uncommitted rows. The run retains source/fetch times, run identity, validation, and daily progress. An advisory lock prevents concurrent importer runs. Source and local counts, distinct IDs, and all daily counts are reconciled before a run is marked validated. If validation reports source membership drift, start a fresh full pass with `npm run import:august -- --new-run`; a normal rerun resumes its latest incomplete checkpoint. Source edits during import are checked through overlapping `:updated_at` refreshes. Full reconciliation tracks membership so records deleted or moved out of the cohort can be reconciled safely.

`npm run import:refresh` provides a manual overlap refresh. Run `npm run import:august` periodically for full cohort reconciliation because an update feed alone cannot reliably represent source deletions or records moved out of the date range. No recurring automation has been created.

The importer and migration reject nonlocal connections or any database name other than `nyc_service_pulse`.

## Verification

```sh
npm test
npm run typecheck
npm run lint
npm run build
# App must already be running; this machine has Google Chrome installed.
npm run test:ui
node --env-file=.env.local --import tsx -e 'process.env.TEST_DATABASE_URL=process.env.DATABASE_URL; await import("./tests/backend.integration.test.ts"); await import("./tests/import.integration.test.ts"); await import("./tests/map.integration.test.ts"); await import("./tests/db.integration.test.ts")'
# With the production app running:
npm run measure
npm run measure:map
```

The browser suite uses installed Google Chrome by default (`PLAYWRIGHT_BROWSER_CHANNEL` can select another installed Playwright channel). It does not start a second app server. The data integration fixtures use connection-local temporary tables and do not alter imported data. A recovery test terminates only its own uniquely tagged PostgreSQL connections, verifying a structured 503, connection eviction, and a successful replacement connection. UI checks use an ephemeral headless Chrome session. API fault/empty/loading cases are simulated in the test browser; the normal dashboard and filters use the actual local database. See `reports/` for measured evidence from this machine.

## Measured first milestone — October 1, 2026

The first full run reconciled **328,892 rows / 328,892 distinct IDs across all 31 August days** against the live source. Import duration: **190.403 seconds**; **121 source requests**; **111,098,352 response bytes**. The request table including indexes occupies **151 MB**.

Quality observations: 303,483 source-Closed records; 303,143 valid nonnegative Closed intervals; 6,302 missing-coordinate records retained; 344 negative intervals across all statuses; 3 Closed records missing a closing date; 3,676 non-Closed records with a closing date. These are observations of this mutable cohort, not future expected assertions.

Production localhost HTTP measurements below use five sequential warm samples after one initial request. JSON sizes are uncompressed body bytes. This was the existing Mac/Docker environment with no other project queries running; this is not a load test or native-Postgres benchmark.

| Endpoint view | Warm median | JSON body | Rows |
| --- | ---: | ---: | ---: |
| Full August cohort | 619.51 ms | 13,508 B | 50 |
| Noise - Residential | 97.32 ms | 13,570 B | 50 |
| August 15 | 31.21 ms | 12,426 B | 50 |
| No matching problem | 41.32 ms | 1,739 B | 0 |
| Problem options | 266.70 ms | 7,096 B | — |

The full-cohort exact median remains the most expensive path (~0.62 seconds warm here). There is no synthetic speed target or cache masking it. Filtered requests are faster; future broader cohorts should revisit aggregation/caching and native database deployment using fresh measurements.

Passed: production build, TypeScript, ESLint, **16 unit tests**, **2 real PostgreSQL integration tests**, and **8 production browser/API checks**. The two opt-in database tests appear skipped in the ordinary unit command and were run separately against temporary tables. Actual browser QA used installed Chrome at desktop 1440×1000 and mobile 390×844; the normal dashboard used imported data, while fault/empty/loading cases used browser-only mocks.

Evidence: [first-milestone HTTP/database measurements](reports/milestone-1/measurements.json), [query-plan comparison](reports/backend-query-profile.json), [import log](reports/import.log), [first-milestone browser results](reports/milestone-1/ui-results.json), [database tests](reports/database-tests.txt), [desktop](reports/ui-desktop.png), [mobile](reports/ui-mobile.png).

## Measured map milestone — October 2, 2026

The production preview remains at **http://127.0.0.1:3100**. The validated August import is unchanged: **328,892 total/distinct requests**, including **322,590 usable locations**. The table and indexes now occupy **164 MB**.

Final localhost measurements used one initial request plus five sequential warm requests per case, with project browser tests stopped. Times include receiving the full HTTP body; sizes below are uncompressed JSON. The database remains the same 1 GB / 1.5 CPU emulated PostGIS container.

| Map view | Warm median | JSON body | Features | Represented requests |
| --- | ---: | ---: | ---: | ---: |
| Default desktop map | 471.40 ms | 3,212 B | 15 grid | 322,590 |
| Study envelope, zoom 10.5 | 596.36 ms | 8,063 B | 41 grid | 322,590 |
| Lower Manhattan, zoom 14 | 35.06 ms | 19,100 B | 102 grid | 15,304 |
| Same neighborhood, Noise - Residential | 25.23 ms | 13,550 B | 72 grid | 1,125 |
| Citywide bounds at maximum API zoom | 819.49 ms | 8,062 B | 41 grid | 322,590 |
| No matching problem | 7.52 ms | 383 B | 0 grid | 0 |
| Small viewport, individual requests | 9.03 ms | 1,326 B | 2 points | 2 |

Each measured viewport count was checked against independent PostGIS `ST_Intersects` SQL; every feature count sum matched, and all feature caps and coordinate bounds held. A deliberately wide viewport at maximum zoom exposed a sort over the full cohort during point probing. Moving the 101-candidate limit before sorting reduced that case from **2,175.80 ms** to **819.49 ms** warm in successive measured runs; point ordering and complete counts are covered by integration tests. Local timing varies: these are observations, not service-level guarantees or load-test results. The earlier measurements are preserved in [map-measurements-before-point-probe.json](reports/map-measurements-before-point-probe.json).

No dashboard regression appeared in this sample: full-cohort `/api/pulse` was **562.73 ms** warm versus **619.51 ms** at the first milestone, with the same **13,508-byte / 50-row** response. Noise - Residential was **69.63 ms** versus **97.32 ms**. This comparison establishes observed behavior on this machine, not a causal speedup from adding the map.

Passed: **20 unit tests**, **4 real PostgreSQL/PostGIS integration tests**, **16 production browser/API checks**, TypeScript, ESLint, and the production build. The final SQL-only candidate-limit change also passed its updated PostGIS ordering/boundary/cap regression and all seven measured HTTP count checks. The copy-only clarification was separately verified in production on desktop and mobile.

Actual Chrome QA covered 1440×1000 desktop and 390×844 mobile, shared filters, cluster zoom, keyboard pan/zoom, the complete accessible list, real request details and focus return, delayed filter/pan responses, and loading/empty/error/retry states. It observed **zero external requests, zero console errors, and no horizontal page overflow**. Six rapid pan keystrokes produced one map request. Initial page-to-map readiness was about **4.9 seconds** in the instrumented browser run; individual interactions settled in **0.4–2.5 seconds**. Those observations include automation, page loading, debounce, assertions, and two animation frames, and are not FPS measurements. Full-page and map screenshots were visually inspected after the live markers loaded.

An earlier stress/profile session interrupted a PostgreSQL backend during expensive JIT work. The container recovered; all imported records remain intact. Besides removing the expensive map JIT path, active connection-loss handling now returns a structured 503 and discards the failed connection. The recovery test proves the next read obtains a healthy replacement, using only test-owned sessions.

Evidence: [final map HTTP measurements](reports/map-measurements.json), [dashboard measurements](reports/measurements.json), [original browser interaction measurements](reports/readiness-original-browser-metrics.json), [16-test browser results](reports/ui-results.json), [database regressions](reports/database-tests.txt), [final point-probe regression](reports/map-final-database-test.txt), [desktop dashboard](reports/ui-desktop.png), [mobile dashboard](reports/ui-mobile.png), [desktop map](reports/map-desktop.png), and [mobile map](reports/map-mobile.png).

## Initial readiness follow-up — October 2, 2026

The original **4.9-second** observation was an instrumented navigation-to-map test, including page loading, API requests, automatic scrolling, locator assertions, and animation frames. It was not a standalone rendering measurement. That run had no phase trace, so its exact historical breakdown cannot be reconstructed.

A new reproducible probe records Navigation/Resource Timing, successful API `Server-Timing`, the app's own single JSON consumption, DOM milestones, and separate Node assertion durations. It runs five fresh desktop browser contexts followed by five fresh mobile viewport contexts, sequentially. Both use Chrome on this Mac; the mobile viewport is not a physical-phone performance test. The production app was restarted for each attempt; database caches were not reset. The first after attempt failed, was preserved, and was followed by one bounded repeat.

| Measured desktop stage, median | Before | After repeat |
| --- | ---: | ---: |
| HTML request to first byte | 32.1 ms | 47.1 ms |
| HTML transfer | 3.2 ms | 7.0 ms |
| HTML end to first API call: JS/hydration/effect proxy | 92.5 ms | 93.7 ms |
| Dashboard API loader | 1,227.53 ms | 3,735.40 ms |
| Map mount to proximity observer | 35.0 ms | 42.3 ms |
| Proximity to Leaflet initialization: local assets/import/setup | 45.8 ms | 51.8 ms |
| Map initialization to first map fetch | **256.0 ms** | **5.2 ms** |
| Map API loader | 937.30 ms | 1,286.08 ms |
| Map response headers to parsed JSON | 0.7 ms | 1.1 ms |
| Parsed JSON to first marker DOM | 5.1 ms | 6.8 ms |
| First marker DOM through two animation frames | 21.8 ms | 19.5 ms |
| Node assertions and their additional two frames | 66.05 ms | 65.51 ms |

Stage medians are not additive: some work overlaps, the loader rows are subsets of request time, and medians can come from different samples. The API loader includes URL/filter parsing, connection-pool acquisition, transaction/SQL, and server result shaping. It excludes response serialization and network/browser work; it is not pure SQL execution time. The hydration proxy includes JavaScript loading and effect scheduling and cannot isolate pure React hydration. DOM readiness after two frames is not a paint guarantee or FPS measurement. Probe hooks and automation also add overhead that is not separately calibrated.

The map waits for `/api/pulse` before it mounts; `/api/problems` runs concurrently and should not be added to that serial path. In the first new baseline run, map readiness took **5.24 s**: dashboard loader **3.50 s** and map loader **0.88 s** accounted for about **84%** of that interval. This supplies evidence for the dominant server-data wait in a comparable initial load, rather than retroactively assigning causes to the earlier 4.9-second sample.

The only performance behavior change skips the **250 ms debounce for the first dispatched map request**. Subsequent pans, filters, and retries retain the existing debounce, cancellation, and stale-result guards. Map-init-to-fetch fell **256.0 → 5.2 ms** on desktop and **255.5 → 3.9 ms** in the mobile viewport. Every successful load still made exactly one map request; six rapid pan keys still produced one request.

There is **no demonstrated end-to-end speedup** in these sequential runs. Browser DOM-readiness medians were **2.75 → 5.56 s** desktop and **3.39 → 4.38 s** mobile viewport. The later run had substantially slower measured API loader work and variable scrolling/proximity delays, outweighing the roughly 251 ms removed from the initial dispatch stage. The data supports that narrow saving, not a claim that the whole page became faster. All individual samples are retained.

The ARM host / AMD64 database image and 1 GB / 1.5 CPU limits are verified environment facts. Cgroup counters recorded **250 throttled periods** during the baseline and **406** during the successful repeat, establishing that CPU quota throttling occurred. These aggregate counters do not identify its per-request cost or quantify emulation overhead. No native comparison was performed, so an emulation slowdown factor remains unknown. The remaining latency limit is the serial dashboard/map data-loading path and its observed server-side variability.

The first after attempt returned **503 from both initial data endpoints after about 3.15 s**, before the map mounted. PostgreSQL was healthy and had no new logged restart. An independent project connection subsequently succeeded in **145.59 ms**. The timing is consistent with the configured three-second pool connection timeout, but the exact failure cause was not established. That failed attempt remains in the evidence; only the app was restarted once, and the repeat passed **10/10 loads**. No Docker platform, resource limits, system settings, software installation, or dataset changes were made.

Verification: **20 unit tests**, TypeScript/production build, ESLint, **20 successful measured loads** across before/repeat, and **8/8 affected map browser checks** in 56.1 seconds. The prior full 16-test report remains preserved. Count sums, caps, shared filters, details/focus, loading/error/retry states, stale responses, and rapid-pan debounce passed. Successful probes and browser checks recorded no external requests or console errors.

Reproduce with a running production preview:

```sh
npm run measure:readiness -- --label my-run-1
```

Use a new label each time: the probe refuses to overwrite reports. Evidence: [comparison and method](reports/readiness-comparison.json), [before traces](reports/readiness-before.json), [successful after traces](reports/readiness-after-retry.json), [preserved failed attempt](reports/readiness-after.json), [connection check](reports/readiness-connection-check.json), [affected browser checks](reports/readiness-ui-tests.txt), and [probe source](scripts/measure-readiness.mjs).

## Deliberate boundaries

No AI, authentication, deployment, or paid infrastructure. The map uses public OpenStreetMap street tiles with local vector geography as a fallback, without a geocoder or an account. Earlier milestone measurements of zero external requests describe the original local-only map. The official pinned PostGIS image currently runs as `linux/amd64` under Docker emulation on this Apple Silicon Mac. Its 1 GB memory and 1.5 CPU limits keep this local project bounded; benchmarks describe that environment rather than claiming native or production performance. Exact aggregates and a median over this bounded month favor simplicity over a separate rollup/cache invalidation system. The pooled database connection count is five.
