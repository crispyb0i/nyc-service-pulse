/**
 * Rebuild the local, shoreline-only map with the existing project database.
 * node --env-file=.env.local scripts/prepare-map-geography.mjs
 * Makes four bounded public downloads; all PostGIS queries are READ ONLY.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const sourceUrl = "https://data.cityofnewyork.us/resource/gthc-hcne.geojson?$limit=5&$order=borocode";
const metadataUrl = "https://data.cityofnewyork.us/api/views/gthc-hcne.json";
const ntaUrl = "https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$limit=500&$order=nta2020";
const ntaMetadataUrl = "https://data.cityofnewyork.us/api/views/9nt8-h7nd.json";
const sourcePage = "https://www.nyc.gov/content/planning/pages/resources/datasets/borough-boundaries";
const toleranceFeet = 45;
const root = fileURLToPath(new URL("../", import.meta.url));
const fetchPublic = (url) => execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "3", "--retry-delay", "2", "--max-time", "60", "--max-filesize", "8388608", url], { maxBuffer: 8 * 1024 * 1024 });
const raw = fetchPublic(sourceUrl);
const metadata = JSON.parse(fetchPublic(metadataUrl).toString());
const ntaRaw = fetchPublic(ntaUrl);
const ntaMetadata = JSON.parse(fetchPublic(ntaMetadataUrl).toString());
const ntaSource = JSON.parse(ntaRaw.toString());
assert.equal(ntaSource.type, "FeatureCollection");
assert(ntaSource.features.length < 500, "NTA source hit the download cap; check pagination");
const fetchedAt = new Date().toISOString();
const source = JSON.parse(raw.toString());
const names = ["Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"];
assert.equal(source.type, "FeatureCollection");
assert.equal(source.features.length, 5);
assert.deepEqual(source.features.map((feature) => feature.properties.boroname).sort(), [...names].sort());
assert(process.env.DATABASE_URL, "Pass the project's .env.local using --env-file");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 30_000, application_name: "nyc-service-pulse-geography" });
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const { rows } = await client.query(`
    WITH original AS (
      SELECT feature->'properties'->>'borocode' AS code,
        feature->'properties'->>'boroname' AS name,
        ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(feature->>'geometry'), 4326), 2263) AS geom
      FROM jsonb_array_elements($1::jsonb->'features') AS feature
    ), simplified AS (
      SELECT *, ST_SimplifyPreserveTopology(geom, $2) AS simple FROM original
    ), output AS (
      SELECT *, ST_Multi(ST_ReducePrecision(ST_Transform(simple, 4326), 0.0000001)) AS display FROM simplified
    )
    SELECT code, name, ST_AsGeoJSON(display, 7)::json AS geometry,
      ST_AsGeoJSON(ST_Transform(ST_PointOnSurface(geom), 4326), 7)::json AS label,
      ST_IsValid(geom) AS source_valid, ST_IsValid(display) AS output_valid,
      ST_NPoints(geom) AS source_points, ST_NPoints(display) AS output_points,
      ST_NumGeometries(geom) AS source_polygons, ST_NumGeometries(display) AS output_polygons,
      abs(ST_Area(ST_Transform(display, 2263)) - ST_Area(geom)) / ST_Area(geom) AS area_change_fraction,
      ST_Covers(geom, ST_PointOnSurface(geom)) AS label_on_land,
      ARRAY[ST_XMin(display), ST_YMin(display), ST_XMax(display), ST_YMax(display)] AS bbox
    FROM output ORDER BY code`, [JSON.stringify(source), toleranceFeet]);
  const { rows: ntaRows } = await client.query(`
    WITH areas AS (
      SELECT feature->'properties'->>'nta2020' AS code,
        feature->'properties'->>'ntaname' AS name,
        ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(feature->>'geometry'), 4326), 2263) AS geom
      FROM jsonb_array_elements($1::jsonb->'features') AS feature
      WHERE feature->'properties'->>'ntatype' = '0'
    )
    SELECT code, name, ST_AsGeoJSON(ST_Transform(ST_PointOnSurface(geom), 4326), 7)::json AS geometry,
      ST_IsValid(geom) AS valid, ST_Covers(geom, ST_PointOnSurface(geom)) AS covered
    FROM areas ORDER BY code`, [JSON.stringify(ntaSource)]);
  assert(ntaRows.length > 150 && ntaRows.length < 300, "Unexpected residential NTA count");
  assert.equal(new Set(ntaRows.map((row) => row.code)).size, ntaRows.length);
  for (const row of ntaRows) {
    assert(row.valid && row.covered && row.name, `${row.code}: invalid NTA label`);
    const [longitude, latitude] = row.geometry.coordinates;
    assert(longitude > -74.3 && longitude < -73.65 && latitude > 40.45 && latitude < 40.95);
  }
  const postgis = (await client.query("SELECT postgis_full_version() AS version")).rows[0].version;
  await client.query("COMMIT");

  // Runnable checks catch a changed source, broken geometry, or over-aggressive simplification.
  assert.deepEqual(rows.map((row) => row.name), names);
  for (const row of rows) {
    assert(row.source_valid && row.output_valid, `${row.name}: invalid polygon`);
    assert(row.label_on_land, `${row.name}: label fell outside its borough`);
    assert(row.area_change_fraction < 0.002, `${row.name}: area changed by >0.2%`);
    assert.equal(row.geometry.type, "MultiPolygon");
    assert(row.bbox[0] > -74.3 && row.bbox[2] < -73.65 && row.bbox[1] > 40.45 && row.bbox[3] < 40.95);
  }
  const boroughs = { type: "FeatureCollection", features: rows.map((row) => ({ type: "Feature", id: row.code, properties: { code: row.code, name: row.name }, geometry: row.geometry })) };
  const labels = { type: "FeatureCollection", features: rows.map((row) => ({ type: "Feature", id: row.code, properties: { code: row.code, name: row.name, kind: "borough" }, geometry: row.label })) };
  const neighborhoodLabels = { type: "FeatureCollection", features: ntaRows.map((row) => ({ type: "Feature", properties: { code: row.code, name: row.name, kind: "neighborhood" }, geometry: row.geometry })) };
  const neighborhoodJson = JSON.stringify(neighborhoodLabels) + "\n";
  assert(Buffer.byteLength(neighborhoodJson) < 50_000, "Neighborhood label asset exceeds 50KB");
  const boroughJson = JSON.stringify(boroughs) + "\n";
  const labelJson = JSON.stringify(labels) + "\n";
  assert(Buffer.byteLength(boroughJson) < 500_000, "Boundary asset exceeds the 500KB budget");
  const report = {
    generatedAt: fetchedAt,
    source: { title: metadata.name, publisher: metadata.attribution, datasetId: metadata.id, description: metadata.description, metadataUrl, geojsonUrl: sourceUrl, landingPage: sourcePage, version: metadata.description.match(/Current version: ([\w.]+)/)?.[1] ?? null, rowsUpdatedAt: new Date(metadata.rowsUpdatedAt * 1000).toISOString(), bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") },
    neighborhoods: { title: ntaMetadata.name, publisher: ntaMetadata.attribution, datasetId: ntaMetadata.id, description: ntaMetadata.description, metadataUrl: ntaMetadataUrl, geojsonUrl: ntaUrl, landingPage: "https://www.nyc.gov/content/planning/pages/resources/datasets/neighborhood-tabulation", version: ntaMetadata.description.match(/Current version: ([\w.]+)/)?.[1] ?? null, rowsUpdatedAt: new Date(ntaMetadata.rowsUpdatedAt * 1000).toISOString(), sourceBytes: ntaRaw.length, sourceSha256: createHash("sha256").update(ntaRaw).digest("hex"), sourceFeatures: ntaSource.features.length, outputFeatures: ntaRows.length, outputBytes: Buffer.byteLength(neighborhoodJson), outputSha256: createHash("sha256").update(neighborhoodJson).digest("hex"), processing: "NTAType=0 residential statistical areas only; ST_PointOnSurface in EPSG:2263 transformed to WGS84. No NTA polygons are shipped to the browser.", caveat: "Official NTA names roughly correspond to common neighborhoods but are statistical geography, not definitive or exhaustive neighborhood names or boundaries." },
    attribution: { text: "NYC Department of City Planning", url: sourcePage },
    use: { metadataLicenseId: metadata.licenseId ?? null, sourceIsPublicOpenData: true, termsUrl: "https://www.nyc.gov/main/terms-of-use", metadataAttachmentUrl: "https://data.cityofnewyork.us/api/views/gthc-hcne/files/f0af73fe-df03-43fe-91b3-0c0553c83008?download=true&filename=nybb_metadata.pdf", note: "NYC Open Data public download. No SPDX or Creative Commons license is assigned in the dataset metadata; do not label it CC0. DCP provides its data for informational use without a warranty of completeness, accuracy, or fitness. Retain DCP attribution and consult the linked source terms before redistribution outside this local portfolio." },
    processing: { method: "ST_SimplifyPreserveTopology in EPSG:2263 (US survey feet), then ST_ReducePrecision to 1e-7 degrees after WGS84 transform", toleranceFeet, approximateToleranceMeters: toleranceFeet * 1200 / 3937, outputCrs: "EPSG:4326 / GeoJSON longitude, latitude", postgis, labelMethod: "ST_PointOnSurface of the original borough polygon, transformed to WGS84; labels are display anchors, not official centroids", limitation: "Simplification preserves each borough's topology, not shared-edge topology between different boroughs. Shoreline-only contextual map, not a street map, survey, geocoder, or spatial filter. All service-request coordinates remain untouched." },
    runtime: { externalNetworkRequests: 0, files: ["/map/boroughs.geojson", "/map/labels.geojson", "/map/neighborhood-labels.geojson"], suggestedInitialBounds: [-74.27, 40.49, -73.69, 40.93] },
    output: { boroughBytes: Buffer.byteLength(boroughJson), labelBytes: Buffer.byteLength(labelJson), sha256: createHash("sha256").update(boroughJson).digest("hex"), features: rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "geometry" && key !== "label"))) },
  };
  await mkdir(root + "public/map", { recursive: true });
  await mkdir(root + "reports", { recursive: true });
  await writeFile(root + "public/map/boroughs.geojson", boroughJson);
  await writeFile(root + "public/map/labels.geojson", labelJson);
  await writeFile(root + "public/map/neighborhood-labels.geojson", neighborhoodJson);
  await writeFile(root + "reports/geography-source.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ sourceBytes: raw.length, boroughBytes: report.output.boroughBytes, labelBytes: report.output.labelBytes, neighborhoods: report.neighborhoods.outputFeatures, neighborhoodBytes: report.neighborhoods.outputBytes, features: report.output.features }, null, 2));
} finally {
  await client.query("ROLLBACK").catch(() => {});
  client.release();
  await pool.end();
}
