import assert from "node:assert/strict";
import test from "node:test";
import { FilterError } from "../src/lib/filters";
import { createGetHandler } from "../src/lib/http";
import { clipBounds, gridCellSize, parseMapQuery, project, queryMap } from "../src/lib/map";
import { MAP_STUDY_BOUNDS, MAX_GRID_FEATURES, type MapBounds } from "../src/lib/map-types";

const params = (extra: Record<string, string> = {}) => new URLSearchParams({ west: "-74.1", south: "40.6", east: "-73.8", north: "40.9", zoom: "11.5", ...extra });

test("map validates bounds and reuses the shared inclusive August filter", () => {
  const query = parseMapQuery(params({ from: "2026-08-02", to: "2026-08-03", problem: "Noise' OR TRUE --" }));
  assert.deepEqual(query.filters, { from: "2026-08-02", to: "2026-08-03", problem: "Noise' OR TRUE --" });
  assert.equal(query.zoom, 11.5);
  assert.deepEqual(query.bounds, [-74.1, 40.6, -73.8, 40.9]);
  const invalidCases: Record<string, string>[] = [
    { west: "NaN" }, { south: "Infinity" }, { north: "1e999" }, { zoom: "" }, { west: " " },
    { west: "-181" }, { east: "181" }, { south: "-90" }, { north: "90" },
    { west: "-73" }, { south: "41" }, { north: "40.6" }, { zoom: "8.99" }, { zoom: "18.51" },
    { from: "2026-07-01" }, { from: "2026-08-03", to: "2026-08-02" }, { cursor: "abc" },
  ];
  for (const invalid of invalidCases) assert.throws(() => parseMapQuery(params(invalid)), FilterError, JSON.stringify(invalid));
  const duplicate = params(); duplicate.append("west", "-74");
  assert.throws(() => parseMapQuery(duplicate), FilterError);
  const missing = params(); missing.delete("zoom");
  assert.throws(() => parseMapQuery(missing), FilterError);
});

test("wide legal viewports clip to NYC and disjoint viewports avoid all database queries", async () => {
  const wide = parseMapQuery(params({ west: "-180", south: "-85", east: "180", north: "85", zoom: "18.5" }));
  assert.deepEqual(wide.queryBounds, MAP_STUDY_BOUNDS);
  assert.deepEqual(wide.bounds, [-180, -85, 180, 85]);
  assert.equal(clipBounds([0, 0, 1, 1]), null);
  assert.deepEqual(clipBounds([-75, 40.5, -74.6, 40.6]), [-74.6, 40.5, -74.6, 40.6]);
  const outside = parseMapQuery(params({ west: "0", south: "0", east: "1", north: "1" }));
  const result = await queryMap({ query: async () => { throw new Error("Must not query outside study area"); } }, outside);
  assert.equal(result.visibleRequests, 0);
  assert.deepEqual(result.features, []);
  assert.equal(result.meta.queryBounds, null);
});

test("grid adapts to viewport size and guarantees at most 400 cells even at spoofed high zoom", () => {
  for (const bounds of [MAP_STUDY_BOUNDS, [-74.01, 40.7, -74, 40.71], [-74, 40.7, -73.999999, 40.700001]] as MapBounds[]) {
    for (const zoom of [9, 11.5, 15, 18.5]) {
      const size = gridCellSize(bounds, zoom);
      const [west, south] = project(bounds[0], bounds[1]);
      const [east, north] = project(bounds[2], bounds[3]);
      assert.ok((Math.ceil((east - west) / size) + 2) * (Math.ceil((north - south) / size) + 2) <= MAX_GRID_FEATURES);
      assert.ok(Number.isInteger(Math.log2(size)));
    }
  }
});

test("invalid map params use the existing structured 400 response", async () => {
  const handler = createGetHandler(async (search) => parseMapQuery(search));
  const response = await handler(new Request("http://localhost/api/map?west=NaN"));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_FILTERS");
});
