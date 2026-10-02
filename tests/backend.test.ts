import assert from "node:assert/strict";
import test from "node:test";
import { parseFilters } from "../src/lib/filters";
import { createGetHandler } from "../src/lib/http";

const request = (query = "") => new Request(`http://localhost/api/pulse${query}`);

test("bad filters return a useful 400 and do not reach the data loader", async () => {
  let loaded = false;
  const handler = createGetHandler(async (params) => {
    const filters = parseFilters(params);
    loaded = true;
    return filters;
  });
  const response = await handler(request("?from=2025-01-01"));
  assert.equal(response.status, 400);
  assert.equal(loaded, false);
  assert.equal((await response.json()).error.code, "INVALID_FILTERS");
});

test("database failures are 503 responses with no connection string or SQL details", async () => {
  const handler = createGetHandler(async () => { throw new Error("postgres://username:secret@host SELECT private_column"); });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("server-timing"), null);
  const body = await response.json();
  assert.equal(body.error.code, "DATA_UNAVAILABLE");
  assert.doesNotMatch(body.error.message, /secret|username|private_column/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("successful empty data is 200, distinct from an unavailable database", async () => {
  const handler = createGetHandler(async () => ({ requests: [], daily: [], nextCursor: null }));
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("server-timing") ?? "", /^data;dur=\d+\.\d{2};desc="App loader \(filters, pool, SQL\)"$/);
  assert.deepEqual(await response.json(), { requests: [], daily: [], nextCursor: null });
});
