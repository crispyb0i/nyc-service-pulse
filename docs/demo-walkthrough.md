# A three-minute portfolio walkthrough

1. **The problem (20 seconds).** A month contains hundreds of thousands of NYC 311 records. Opening the browser should not mean downloading all of them. Explain that counts describe a recorded snapshot, and that source status “Closed” is not proof of resolution.
2. **Explore a signal (40 seconds).** Select Noise – Residential, then click a day in the chart. Zoom into the map until streets and buildings are visible. Use “Search this area” to scope the list. The area filter is explicit; panning alone does not silently change the list or citywide metrics.
3. **Follow a request (30 seconds).** Open a table row. Its details and location appear on the map. Copy the URL, reload, and use Back. Close with Escape. Explain the shared filter, camera, cursor and selected-ID state.
4. **Demonstrate scale (40 seconds).** Switch to Continuous list and scroll. Show the bounded cache and mounted-row counts in the engineering evidence. Switch back to the native paged table for an alternative keyboard and assistive-technology reading path.
5. **Show the evidence (40 seconds).** Open the before/after report. Point out that page turns no longer execute the exact median and daily aggregates. Explain the CPU/network conditions, variation across runs, and the difference between an automation-settlement time and paint/INP. Show the reproducible command and CI result.
6. **Discuss tradeoffs (10 seconds).** Exact aggregates remain expensive, the data is a snapshot, and the free cloud database can sleep. A larger/live cohort would need a measured aggregation and invalidation strategy.

Keyboard route: Tab through filters → chart day → map controls or accessible feature list → Search this area → request rows. In Continuous list, use arrow keys or Home/End within the loaded window. The paged table remains available throughout.
