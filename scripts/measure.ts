import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { performance } from 'node:perf_hooks';

const base = 'http://127.0.0.1:3100';
const cases = [
  ['cohort', '/api/pulse'],
  ['complaint', '/api/pulse?problem=Noise%20-%20Residential'],
  ['singleDay', '/api/pulse?from=2026-08-15&to=2026-08-15'],
  ['empty', '/api/pulse?problem=__no_such_problem__'],
  ['problems', '/api/problems'],
];
const measurements = [];
for (const [name, path] of cases) {
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const started = performance.now();
    const response = await fetch(`${base}${path}`);
    const body = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${body}`);
    const parsed = JSON.parse(body);
    if (parsed.daily && parsed.summary.total !== parsed.daily.reduce((sum: number, day: {count: number}) => sum + day.count, 0)) throw new Error('Chart/summary mismatch');
    samples.push({ ms: Math.round((performance.now() - started) * 100) / 100, bytes: Buffer.byteLength(body), total: parsed.summary?.total, rows: parsed.requests?.length });
  }
  const warm = samples.slice(1).map(x => x.ms).sort((a,b) => a-b);
  measurements.push({ name, path, first: samples[0], warmMedianMs: warm[2], warmMaxMs: warm.at(-1), samples });
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const quality = await pool.query(`SELECT count(*)::int total, count(DISTINCT id)::int distinct_ids,
    count(*) FILTER (WHERE status='Closed')::int closed,
    count(*) FILTER (WHERE status='Closed' AND closed_at>=created_at)::int valid_closed_intervals,
    count(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL)::int missing_coordinates,
    count(*) FILTER (WHERE closed_at<created_at)::int negative_intervals,
    pg_size_pretty(pg_total_relation_size('service_requests')) AS table_including_indexes
    FROM service_requests`);
  const runs = await pool.query(`SELECT id, mode,status,phase,started_at,finished_at,
    extract(epoch FROM (finished_at-started_at)) AS wall_seconds, rows_processed,batches_processed,validation
    FROM import_runs ORDER BY started_at DESC`);
  const daily = await pool.query(`SELECT created_at::date::text AS day,count(*)::int AS count FROM service_requests GROUP BY 1 ORDER BY 1`);
  const flags = await pool.query(`SELECT flag,count(*)::int count FROM service_requests,unnest(quality_flags) flag GROUP BY 1 ORDER BY 1`);
  const plans = [];
  for (const query of [
    "SELECT id,created_at FROM service_requests WHERE created_at>='2026-08-01' AND created_at<'2026-09-01' ORDER BY created_at DESC,id DESC LIMIT 51",
    "SELECT id,created_at FROM service_requests WHERE created_at>='2026-08-01' AND created_at<'2026-09-01' AND problem='Noise - Residential' ORDER BY created_at DESC,id DESC LIMIT 51"
  ]) {
    const result = await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`);
    plans.push({ query, plan: result.rows[0]['QUERY PLAN'][0] });
  }
  const report = { measuredAt: new Date().toISOString(), environment: 'MacBook local Next production server, Docker PostgreSQL17/PostGIS3.5 linux/amd64 emulation, database1GB/1.5CPUs; HTTP localhost; first +5 warm sequential requests, uncompressed JSON bytes', measurements, quality: quality.rows[0], runs: runs.rows, daily: daily.rows, flags: flags.rows, plans };
  await writeFile('reports/measurements.json', JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ quality:report.quality, endpoints:measurements.map(x => ({name:x.name,medianMs:x.warmMedianMs,bytes:x.first.bytes,rows:x.first.rows})), report:'reports/measurements.json' },null,2));
} finally { await pool.end(); }
