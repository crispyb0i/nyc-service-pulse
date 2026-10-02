import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { parseFilters } from "../src/lib/filters";
import { queryPulse } from "../src/lib/queries";

// Opt-in only. Fixtures are connection-local temporary tables, never public data.
const connectionString = process.env.TEST_DATABASE_URL;
test("PostgreSQL filters, date quality, empty states and microsecond keyset pagination", { skip: !connectionString }, async () => {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE service_requests (
      id text PRIMARY KEY, created_at timestamp, closed_at timestamp,
      status text, agency text, problem text, detail text, borough text,
      quality_flags text[] DEFAULT '{}', latitude double precision, longitude double precision,
      fetched_at timestamptz DEFAULT now(), source_updated_at timestamptz DEFAULT now()
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE import_runs (
      id uuid, status text, started_at timestamptz, finished_at timestamptz
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO service_requests (id,created_at,closed_at,status,agency,problem,latitude,longitude,quality_flags) VALUES
      ('a1','2026-08-01 10:00','2026-08-01 11:00','Closed','NYPD','Noise',40.7,-74,'{}'),
      ('a2','2026-08-01 10:00','2026-08-01 09:00','Closed','NYPD','Noise',40.7,-74,'{negative_closure_interval}'),
      ('a3','2026-08-01 10:00','2026-08-01 12:00','Open','NYPD','Noise',40.7,-74,'{nonclosed_with_closed_date}'),
      ('a4','2026-08-01 10:00',NULL,'Closed','NYPD','Noise',40.7,-74,'{closed_missing_closed_date}'),
      ('a5','2026-08-02 00:00','2026-08-02 03:00','Closed','NYPD','Noise',NULL,NULL,'{missing_coordinates}'),
      ('a6','2026-08-31 23:59:59.123456','2026-09-01 01:00','Closed','DOHMH','Food',40.7,-74,'{}'),
      ('a7','2026-09-01 00:00',NULL,'Open','NYPD','Noise',40.7,-74,'{}'),
      ('a8','2026-07-31 23:59:59.999999',NULL,'Open','NYPD','Noise',40.7,-74,'{}')`);

    const filtered = await queryPulse(client, parseFilters(new URLSearchParams("from=2026-08-01&to=2026-08-02&problem=Noise")));
    assert.deepEqual(filtered.summary, { total: 5, closed: 4, closedPercent: 80, medianClosureHours: 2, validClosureCount: 2, missingCoordinates: 1 });
    assert.deepEqual(filtered.daily, [{ date: "2026-08-01", count: 4 }, { date: "2026-08-02", count: 1 }]);
    assert.equal(filtered.requests.length, 5);
    assert.equal(filtered.daily.reduce((total, day) => total + day.count, 0), filtered.summary.total);
    assert.equal(filtered.requests[0].id, "a5");
    assert.equal(filtered.requests.find((row) => row.id === "a4")?.closedAt, null);
    assert.equal(filtered.requests.some((row) => row.qualityFlags.includes("negative_closure_interval")), true);
    assert.equal(filtered.nextCursor, null);

    const end = await queryPulse(client, parseFilters(new URLSearchParams("from=2026-08-31&to=2026-08-31")));
    assert.equal(end.summary.total, 1);
    assert.equal(end.requests[0].createdAt, "2026-08-31T23:59:59.123456");
    const empty = await queryPulse(client, parseFilters(new URLSearchParams({ problem: "Noise' OR TRUE --" })));
    assert.equal(empty.summary.total, 0);
    assert.equal(empty.summary.medianClosureHours, null);
    assert.equal(empty.summary.closedPercent, 0);
    assert.equal(empty.requests.length, 0);
    assert.equal(empty.daily.length, 31);
    assert.equal(empty.daily.every((day) => day.count === 0), true);
    assert.equal(empty.nextCursor, null);

    await client.query(`INSERT INTO service_requests (id,created_at,status,agency,problem,latitude,longitude)
      SELECT 'page-' || lpad(n::text, 3, '0'), '2026-08-09 14:00:00.123456', 'Open', 'TEST', 'Pagination', 40.7, -74
      FROM generate_series(1,57) n`);
    const pageOne = await queryPulse(client, parseFilters(new URLSearchParams({ problem: "Pagination" })));
    assert.equal(pageOne.requests.length, 50);
    assert.ok(pageOne.nextCursor);
    const pageTwo = await queryPulse(client, parseFilters(new URLSearchParams({ problem: "Pagination", cursor: pageOne.nextCursor })));
    assert.equal(pageTwo.requests.length, 7);
    assert.equal(new Set([...pageOne.requests, ...pageTwo.requests].map((row) => row.id)).size, 57);
    assert.equal(pageTwo.nextCursor, null);
    assert.deepEqual(pageOne.summary, pageTwo.summary);
    assert.deepEqual(pageOne.daily, pageTwo.daily);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
