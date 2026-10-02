import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { parseRequestsQuery, queryRequest, queryRequests } from "../src/lib/requests";

test("request-only keysets traverse both ways, clip geography and retain missing coordinates", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE service_requests (
      id text PRIMARY KEY, created_at timestamp, closed_at timestamp, status text, agency text,
      problem text, detail text, borough text, quality_flags text[] DEFAULT '{}',
      latitude double precision, longitude double precision, geom geometry(Point,4326)
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO service_requests(id,created_at,problem,latitude,longitude,geom)
      SELECT lpad(n::text,3,'0'),'2026-08-31 12:00:00.123456','Noise',40.75,-74,ST_SetSRID(ST_MakePoint(-74,40.75),4326) FROM generate_series(1,123) n`);
    const page = (extra: Record<string, string> = {}) => queryRequests(client, parseRequestsQuery(new URLSearchParams(extra)));
    const first = await page();
    const second = await page({ cursor: first.nextCursor! });
    const third = await page({ cursor: second.nextCursor! });
    assert.deepEqual([first.requests.length, second.requests.length, third.requests.length], [50,50,23]);
    assert.equal(new Set([...first.requests,...second.requests,...third.requests].map((r) => r.id)).size,123);
    assert.equal(first.previousCursor, null);
    assert.equal(third.nextCursor, null);
    const back = await page({ cursor: third.previousCursor!, direction: "previous" });
    assert.deepEqual(back.requests, second.requests);
    const start = await page({ cursor: back.previousCursor!, direction: "previous" });
    assert.deepEqual(start.requests, first.requests);
    assert.equal(start.previousCursor, null);
    assert.equal(first.requests[0].createdAt, "2026-08-31T12:00:00.123456");
    await client.query("UPDATE service_requests SET latitude=NULL,longitude=NULL,geom=NULL WHERE id='123'");
    const missing = await queryRequest(client,"123");
    assert.equal(missing.request?.latitude,null);
    assert.equal((await page()).requests.length,50);
    const bounds = { west: "-74", south: "40.7", east: "-73.9", north: "40.8" };
    const spatial = await page(bounds);
    assert.equal(spatial.requests[0].id,"122");
    const spatialBack = await page({ ...bounds, cursor: (await page({ ...bounds,cursor:spatial.nextCursor! })).previousCursor!,direction:"previous" });
    assert.deepEqual(spatialBack.requests,spatial.requests);
    assert.equal((await page({ ...bounds,west:"-73.99" })).requests.length,0);
    assert.equal((await page({ west:"0",south:"0",east:"1",north:"1" })).requests.length,0);
    assert.equal((await page({ problem:"Noise' OR TRUE --" })).requests.length,0);
    assert.equal((await queryRequest(client,"' OR TRUE --")).request,null);
    assert.equal((await queryRequest(client,"absent")).request,null);
    await client.query("UPDATE service_requests SET created_at='2026-09-01' WHERE id='123'");
    assert.equal((await queryRequest(client,"123")).request,null);
  } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); await pool.end(); }
});
