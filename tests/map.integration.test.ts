import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { parseMapQuery, project, queryMap } from "../src/lib/map";
import { MAP_STUDY_BOUNDS, type MapResponse } from "../src/lib/map-types";
import { parseFilters } from "../src/lib/filters";
import { queryPulse } from "../src/lib/queries";

const connectionString = process.env.TEST_DATABASE_URL;
const params = (extra: Record<string, string> = {}) => new URLSearchParams({ from: "2026-08-01", to: "2026-08-01", problem: "Noise", west: "-74.01", south: "40.7", east: "-74", north: "40.71", zoom: "15", ...extra });
function assertConserved(result: MapResponse, expected: number) {
  assert.equal(result.visibleRequests, expected);
  assert.equal(result.features.reduce((sum, row) => sum + row.count, 0), expected);
  assert.ok(result.features.length <= (result.mode === "grid" ? 400 : 100));
  for (const feature of result.features) {
    assert.ok(feature.longitude >= result.bounds[0] && feature.longitude <= result.bounds[2]);
    assert.ok(feature.latitude >= result.bounds[1] && feature.latitude <= result.bounds[3]);
    assert.ok(feature.longitude >= feature.bounds[0] - 1e-10 && feature.longitude <= feature.bounds[2] + 1e-10);
    assert.ok(feature.latitude >= feature.bounds[1] - 1e-10 && feature.latitude <= feature.bounds[3] + 1e-10);
  }
}

test("PostGIS map conserves viewport counts, filter scope, boundary points and bounded detail", { skip: !connectionString }, async () => {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE service_requests (
      id text PRIMARY KEY, created_at timestamp DEFAULT '2026-08-01 12:34:56.123456', closed_at timestamp,
      status text DEFAULT 'Open', agency text DEFAULT 'TEST', problem text DEFAULT 'Noise', detail text, borough text,
      quality_flags text[] DEFAULT '{}', latitude double precision, longitude double precision,
      geom geometry(Point,4326), fetched_at timestamptz DEFAULT now(), source_updated_at timestamptz DEFAULT now()
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE import_runs(id uuid,status text,started_at timestamptz,finished_at timestamptz) ON COMMIT DROP`);
    await client.query(`INSERT INTO service_requests(id,longitude,latitude) VALUES
      ('west-edge',-74.01,40.7),('east-edge',-74,40.71),
      ('shared-1',-74.005,40.705),('shared-2',-74.005,40.705),
      ('just-outside',-74.0100001,40.705),('missing',NULL,NULL),('outside-study',-72,40.705)`);
    await client.query(`INSERT INTO service_requests(id,longitude,latitude,problem) VALUES('food',-74.005,40.705,'Food')`);
    await client.query(`INSERT INTO service_requests(id,longitude,latitude,created_at) VALUES('next-day',-74.005,40.705,'2026-08-02 00:00:00')`);
    await client.query(`UPDATE service_requests SET geom=ST_SetSRID(ST_MakePoint(longitude,latitude),4326) WHERE longitude IS NOT NULL`);

    // The compact grid formula agrees with PostGIS EPSG:3857 at NYC coordinates.
    const projected = await client.query("SELECT ST_X(ST_Transform(geom,3857)) x,ST_Y(ST_Transform(geom,3857)) y FROM service_requests WHERE id='shared-1'");
    const expectedProjection = project(-74.005,40.705);
    assert.ok(Math.abs(projected.rows[0].x - expectedProjection[0]) < 1e-7);
    assert.ok(Math.abs(projected.rows[0].y - expectedProjection[1]) < 1e-7);
    await client.query("UPDATE service_requests SET created_at='2026-08-01 11:34:56.123456' WHERE id='west-edge'");
    const points = await queryMap(client, parseMapQuery(params()));
    assert.equal(points.mode, "points");
    assertConserved(points, 4);
    assert.deepEqual(points.features.map((feature) => feature.request?.id), ["shared-2", "shared-1", "east-edge", "west-edge"], "sort complete point results by created_at DESC, then text ID DESC");
    assert.equal(new Set(points.features.map((feature) => feature.request?.id)).size, 4);
    assert.equal(points.features.filter((feature) => feature.longitude === -74.005).length, 2);
    assert.equal(points.features[0].request?.createdAt, "2026-08-01T12:34:56.123456");
    assert.equal(points.features.some((feature) => feature.request?.id === "just-outside"), false);
    const grid = await queryMap(client, parseMapQuery(params({ zoom: "11" })));
    assert.equal(grid.mode, "grid");
    assertConserved(grid, 4);
    assert.equal(grid.features.some((feature) => feature.request), false);

    const allStudy = await queryMap(client, parseMapQuery(params({ west: String(MAP_STUDY_BOUNDS[0]), south: String(MAP_STUDY_BOUNDS[1]), east: String(MAP_STUDY_BOUNDS[2]), north: String(MAP_STUDY_BOUNDS[3]), zoom: "11" })));
    assertConserved(allStudy, 5);
    const pulse = await queryPulse(client, parseFilters(new URLSearchParams("from=2026-08-01&to=2026-08-01&problem=Noise")));
    assert.equal(pulse.summary.total, 7);
    assert.equal(pulse.summary.missingCoordinates, 1);
    const food = await queryMap(client, parseMapQuery(params({ problem: "Food" })));
    assertConserved(food, 1);
    const dates = await queryMap(client, parseMapQuery(params({ to: "2026-08-02" })));
    assertConserved(dates, 5);
    const empty = await queryMap(client, parseMapQuery(params({ problem: "Noise' OR TRUE --" })));
    assertConserved(empty, 0);

    await client.query(`INSERT INTO service_requests(id,problem,geom,latitude,longitude)
      SELECT 'dense-'||n,'Dense',ST_SetSRID(ST_MakePoint(-74.005,40.705),4326),40.705,-74.005 FROM generate_series(1,101) n`);
    const dense = await queryMap(client, parseMapQuery(params({ problem: "Dense", zoom: "18.5" })));
    assert.equal(dense.mode, "grid");
    assert.equal(dense.features.length, 1);
    assertConserved(dense, 101);
    await client.query("DELETE FROM service_requests WHERE id='dense-101'");
    const threshold = await queryMap(client, parseMapQuery(params({ problem: "Dense", zoom: "18.5" })));
    assert.equal(threshold.mode, "points");
    assertConserved(threshold, 100);

    await client.query(`INSERT INTO service_requests(id,problem,geom,latitude,longitude)
      SELECT 'spread-'||x||'-'||y,'Spread',ST_SetSRID(ST_MakePoint(-74.59+x*0.045,40.31+y*0.032),4326),40.31+y*0.032,-74.59+x*0.045
      FROM generate_series(0,24) x CROSS JOIN generate_series(0,24) y`);
    const spoofed = await queryMap(client, parseMapQuery(params({ problem: "Spread", west: "-180", south: "-85", east: "180", north: "85", zoom: "18.5" })));
    await client.query("INSERT INTO service_requests(id,problem,geom) VALUES('study-edge','Study edge',ST_SetSRID(ST_MakePoint(-74.6,40.55),4326))");
    const touching = await queryMap(client, parseMapQuery(params({problem:"Study edge",west:"-75",east:"-74.6",south:"40.5",north:"40.6"})));
    assertConserved(touching, 1);
    assert.equal(spoofed.mode, "grid");
    assertConserved(spoofed, 625);
    assert.ok(spoofed.features.length < 400);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
