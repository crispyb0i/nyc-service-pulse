# Portfolio verification

- `npm run typecheck`: passed.
- `npm run lint`: exit 0; one retained TanStack Virtual / React Compiler compatibility warning. React Compiler is not enabled.
- `npm test`: 24 passed; five database tests skipped without TEST_DATABASE_URL.
- `TEST_DATABASE_URL=<local database> npm run test:db`: five real PostgreSQL/PostGIS tests passed. Test fixtures use temporary tables and owned sessions; no imported records were modified.
- `npm run build`: passed.
- `npm run test:ui`: 28 passed on the final build; report is ui-results.json. Earlier failed attempts are preserved in attempt-1, attempt-2 and attempt-3, with explanations.
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
