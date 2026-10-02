import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FILTERS, FIRST_PAGE, explorerParams, parseExplorerState, requestParams } from "../src/lib/explorer-state";
import { encodeCursor } from "../src/lib/filters";
import { parseRequestId, parseRequestsQuery } from "../src/lib/requests";

test("exploration URLs round-trip selection, area, camera, cursor and browsing mode", () => {
  const state = { ...FIRST_PAGE, filters: DEFAULT_FILTERS, area: [-74, 40.7, -73.9, 40.8] as [number, number, number, number], camera: { latitude: 40.75, longitude: -73.95, zoom: 15.5 }, request: "123", mode: "continuous" as const, cursor: "abc_123", direction: "previous" as const, page: 4 };
  assert.deepEqual(parseExplorerState(explorerParams(state)), state);
  assert.equal(requestParams(state.filters, state.area, state).get("direction"), "previous");
});

test("malformed shared links cannot inject invalid filters or camera coordinates", () => {
  const state = parseExplorerState(new URLSearchParams("from=2026-02-31&to=evil&area=0,0,NaN,1&view=100,200,90&after=a&before=b&request=%00&problem=%00&mode=bad"));
  assert.deepEqual(state.filters, DEFAULT_FILTERS);
  assert.equal(state.area, null);
  assert.equal(state.camera, null);
  assert.equal(state.cursor, null);
  assert.equal(state.request, null);
  assert.equal(state.mode, "pages");
});

test("request cursors cannot cross date, complaint or geographic scopes", () => {
  const filters = { ...DEFAULT_FILTERS, problem: null };
  const point = { id: "123", createdAt: "2026-08-31T12:00:00.123456" };
  const bounds = [-74, 40.7, -73.9, 40.8];
  const cursor = encodeCursor(point, filters, JSON.stringify(bounds));
  const params = new URLSearchParams({ cursor, west: "-74", south: "40.7", east: "-73.9", north: "40.8" });
  assert.deepEqual(parseRequestsQuery(params).cursor, point);
  params.set("east", "-73.8");
  assert.throws(() => parseRequestsQuery(params));
  assert.throws(() => parseRequestsQuery(new URLSearchParams({ cursor })));
  const unscoped = encodeCursor(point, filters);
  assert.deepEqual(parseRequestsQuery(new URLSearchParams({ cursor: unscoped })).cursor, point);
  assert.throws(() => parseRequestsQuery(new URLSearchParams({ cursor: unscoped, from: "2026-08-02" })));
  assert.throws(() => parseRequestsQuery(new URLSearchParams({ cursor: unscoped, problem: "Noise" })));
});

test("request APIs reject incomplete, duplicate and unsupported parameters", () => {
  for (const query of ["direction=previous", "direction=bad", "cursor=", "west=-74", "from=2026-08-01&from=2026-08-02", "limit=100000", "west=-74&south=NaN&east=-73&north=41"]) assert.throws(() => parseRequestsQuery(new URLSearchParams(query)), query);
  for (const query of ["", "id=", "id=a&id=b", "id=a&sql=x", "id=%00"]) assert.throws(() => parseRequestId(new URLSearchParams(query)), query);
  assert.equal(parseRequestId(new URLSearchParams({ id: "' OR TRUE --" })), "' OR TRUE --");
});
