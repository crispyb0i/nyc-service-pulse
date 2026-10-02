import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { localDatabaseUrl } from "../src/lib/ingest";

// Never replace an imported cohort. This fixture exists only in CI's empty local DB.
if (process.env.CI !== "true") throw new Error("Synthetic seeding is restricted to CI.");
const client = new Client({ connectionString: localDatabaseUrl() });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query(await readFile("db/schema.sql", "utf8"));
  const existing = await client.query("SELECT count(*)::int AS count FROM service_requests");
  if (existing.rows[0].count) throw new Error("Refusing to seed a populated database.");
  await client.query(`INSERT INTO import_runs(id,mode,status,finished_at,rows_processed)
    VALUES('00000000-0000-4000-8000-000000000001','full','validated',now(),6200)`);
  await client.query(`INSERT INTO service_requests(id,created_at,closed_at,status,agency,problem,detail,borough,latitude,longitude,geom,fetched_at,source_updated_at,import_run_id)
    SELECT 'CI-'||lpad(n::text,6,'0'), '2026-08-01'::timestamp + (n%31)*interval '1 day' + (n%86400)*interval '1 second',
      '2026-08-02'::timestamp + (n%31)*interval '1 day' + (n%86400)*interval '1 second',
      'Closed','NYPD',CASE WHEN n%2=0 THEN 'Noise - Residential' ELSE 'Illegal Parking' END,
      'Synthetic CI fixture','BROOKLYN',40.56+(n%100)*0.003,-74.2+(n%97)*0.005,
      ST_SetSRID(ST_MakePoint(-74.2+(n%97)*0.005,40.56+(n%100)*0.003),4326),now(),now(),'00000000-0000-4000-8000-000000000001'
    FROM generate_series(1,6200) n`);
  await client.query("ANALYZE service_requests");
  await client.query("COMMIT");
  console.log("Seeded 6,200 synthetic CI records in an empty local database.");
} finally { await client.end(); }
