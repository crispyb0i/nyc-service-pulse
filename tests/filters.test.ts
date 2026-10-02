import assert from "node:assert/strict";
import test from "node:test";
import { buildPredicate, dateSeries, decodeCursor, encodeCursor, FilterError, parseFilters } from "../src/lib/filters";

const defaults = { from: "2026-08-01", to: "2026-08-31", problem: null };

test("filter defaults cover only the complete August cohort", () => {
  assert.deepEqual(parseFilters(new URLSearchParams()), { ...defaults, cursor: null });
  assert.equal(dateSeries(defaults.from, defaults.to).length, 31);
  assert.deepEqual(dateSeries("2026-08-31", "2026-08-31"), ["2026-08-31"]);
});

test("rejects invalid, reversed, out-of-cohort and ambiguous query dates", () => {
  for (const params of [
    "from=2026-08-00", "to=2026-08-32", "from=2026-07-31", "to=2026-09-01",
    "from=2026-08-20&to=2026-08-19", "from=2026-08-01T00:00:00Z", "from=2026-08-01&from=2026-08-02",
    "unknown=1", "cursor=", "problem=%00", "problem=+++",
  ]) assert.throws(() => parseFilters(new URLSearchParams(params)), FilterError, params);
});

test("keeps complaint filters as SQL parameters with an exclusive next-day boundary", () => {
  const problem = "Noise' OR TRUE --";
  const result = buildPredicate({ ...defaults, to: "2026-08-03", problem });
  assert.equal(result.sql.includes(problem), false);
  assert.match(result.sql, /problem = \$3/);
  assert.match(result.sql, /< \$2::timestamp \+ interval '1 day'/);
  assert.deepEqual(result.values, ["2026-08-01T00:00:00", "2026-08-03T00:00:00", problem]);
});

test("cursor roundtrips microsecond timestamps and text IDs without timezone conversion", () => {
  const row = { createdAt: "2026-08-31T23:59:59.123456", id: "0000123456789" };
  const encoded = encodeCursor(row, defaults);
  assert.deepEqual(decodeCursor(encoded, defaults), row);
  assert.deepEqual(parseFilters(new URLSearchParams({ cursor: encoded })).cursor, row);
});

test("cursors cannot be reused across complaint or date filters", () => {
  const encoded = encodeCursor({ createdAt: "2026-08-15T12:30:40.123456", id: "12345" }, defaults);
  assert.throws(() => decodeCursor(encoded, { ...defaults, problem: "Noise" }), FilterError);
  assert.throws(() => decodeCursor(encoded, { ...defaults, from: "2026-08-02" }), FilterError);
  assert.throws(() => decodeCursor("not_json", defaults), FilterError);
  assert.throws(() => decodeCursor(`${encoded}!`, defaults), FilterError);
  assert.throws(() => decodeCursor("a".repeat(2049), defaults), FilterError);
});

test("cursor validation rejects impossible times and dates outside the selected interval", () => {
  for (const createdAt of ["2026-08-15T25:00:00", "2026-08-32T12:00:00", "2026-09-01T00:00:00", "2026-08-15T12:00:00Z"]) {
    const cursor = encodeCursor({ createdAt, id: "123" }, defaults);
    assert.throws(() => decodeCursor(cursor, defaults), FilterError);
  }
  assert.throws(() => parseFilters(new URLSearchParams("cursor=abc"), false), FilterError);
});
