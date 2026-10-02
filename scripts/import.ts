import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { augustDays, COHORT_WHERE, compareCounts, localDatabaseUrl, normalizePage, overlapSince,
  pageUrl, SOURCE_URL, sourceInstant, type DayCount, type Snapshot, type SourceRow } from '../src/lib/ingest';
import { commitPage } from '../src/lib/ingest-store';

type Run = { id: string; mode: 'full' | 'refresh'; phase: string; started_at: Date; updated_since: Date | null;
  source_snapshot: Snapshot; phase_snapshot: Snapshot | null; rows_processed: string; batches_processed: number };
const args = process.argv.slice(2);
const mode = args.find(arg => arg.startsWith('--mode='))?.split('=')[1] ?? 'full';
const pageSize = Number(args.find(arg => arg.startsWith('--page-size='))?.split('=')[1] ?? 5000);
if (!['full', 'refresh'].includes(mode) || !Number.isInteger(pageSize) || pageSize < 100 || pageSize > 5000) {
  throw new Error('Usage: import.ts --mode=full|refresh [--page-size=100..5000] [--new-run]');
}
const client = new pg.Client({ connectionString: localDatabaseUrl(), application_name: 'nyc-service-pulse-import' });
const abort = new AbortController();
let interrupted = false;
let run: Run | undefined;
let responseBytes = 0;
let requests = 0;
process.once('SIGINT', () => { interrupted = true; abort.abort(); });
process.once('SIGTERM', () => { interrupted = true; abort.abort(); });

async function sourceFetch(url: string): Promise<SourceRow[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (interrupted) throw new Error('Import interrupted');
    try {
      requests++;
      const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'NYC-Service-Pulse-local-import/1.0' },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]) });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 400);
        if (response.status !== 429 && response.status < 500) throw new FatalSourceError(`SODA ${response.status}: ${body}`);
        const retryAfter = response.headers.get('retry-after');
        const wait = retryAfter ? Math.min(60_000, Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now()) : 0;
        if (wait > 0) await delay(wait, undefined, { signal: abort.signal });
        throw new Error(`SODA ${response.status}: ${body}`);
      }
      const text = await response.text();
      responseBytes += Buffer.byteLength(text);
      const rows: unknown = JSON.parse(text);
      if (!Array.isArray(rows)) throw new FatalSourceError('SODA returned a non-array response');
      await delay(200, undefined, { signal: abort.signal });
      return rows as SourceRow[];
    } catch (error) {
      if (interrupted || error instanceof FatalSourceError || attempt === 5) throw error;
      const milliseconds = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      console.warn(`Source retry ${attempt + 1}/5 in ${milliseconds}ms: ${error instanceof Error ? error.message : String(error)}`);
      await delay(milliseconds, undefined, { signal: abort.signal });
    }
  }
  throw new Error('Unreachable retry state');
}
class FatalSourceError extends Error {}

async function snapshot(): Promise<Snapshot> {
  const url = new URL(SOURCE_URL);
  url.search = new URLSearchParams({
    $select: 'date_trunc_ymd(created_date) as day,count(*) as count,count(distinct unique_key) as distinct_count,max(:updated_at) as max_updated_at,min(unique_key) as min_id,max(unique_key) as max_id',
    $where: COHORT_WHERE, $group: 'date_trunc_ymd(created_date)', $order: 'day ASC', $limit: '31',
  }).toString();
  const rows = await sourceFetch(url.toString());
  const days = rows.map(row => ({ day: String(row.day).slice(0, 10), count: Number(row.count), distinct: Number(row.distinct_count), minimumId: row.min_id ? String(row.min_id) : null, maximumId: row.max_id ? String(row.max_id) : null }));
  const updates = rows.map(row => sourceInstant(row.max_updated_at)).filter((value): value is string => value !== null).sort();
  return { fetchedAt: new Date().toISOString(), total: days.reduce((sum, row) => sum + row.count, 0),
    distinct: days.reduce((sum, row) => sum + row.distinct, 0), maxUpdatedAt: updates.at(-1) ?? null, days };
}

async function localCounts(seenRun?: string): Promise<DayCount[]> {
  const result = seenRun
    ? await client.query(`SELECT to_char(day,'YYYY-MM-DD') AS day,count(*)::int AS count,count(DISTINCT id)::int AS distinct FROM import_seen WHERE run_id=$1 GROUP BY day ORDER BY day`, [seenRun])
    : await client.query(`SELECT to_char(created_at,'YYYY-MM-DD') AS day,count(*)::int AS count,count(DISTINCT id)::int AS distinct FROM service_requests WHERE created_at >= '2026-08-01' AND created_at < '2026-09-01' GROUP BY to_char(created_at,'YYYY-MM-DD') ORDER BY day`);
  return result.rows as DayCount[];
}

async function scan(phase: string, bounds: Snapshot, updatedSince: string | null): Promise<void> {
  if (!run) throw new Error('Run not initialized');
  const checkpoints = await client.query('SELECT day::text,last_id,completed FROM import_checkpoints WHERE run_id=$1 AND phase=$2', [run.id, phase]);
  const byDay = new Map(checkpoints.rows.map(row => [row.day, row]));
  for (const day of augustDays()) {
    const checkpoint = byDay.get(day);
    if (checkpoint?.completed) continue;
    let cursor: string | null = checkpoint?.last_id ?? null;
    const dayBounds = bounds.days.find(item => item.day === day);
    const minimumId = dayBounds?.minimumId;
    if (!dayBounds || dayBounds.count === 0) {
      await commitPage(client, { runId: run.id, phase, day, rows: [], lastId: cursor, completed: true, trackMembership: run.mode === 'full' });
      continue;
    }
    for (;;) {
      if (interrupted) throw new Error('Import interrupted');
      const source = await sourceFetch(pageUrl(day, cursor, pageSize, updatedSince, minimumId, dayBounds.maximumId));
      const rows = normalizePage(source, cursor, new Date().toISOString());
      const lastId = rows.at(-1)?.id ?? cursor;
      const completed = source.length < pageSize;
      await commitPage(client, { runId: run.id, phase, day, rows, lastId, completed, trackMembership: run.mode === 'full' });
      console.log(JSON.stringify({ phase, day, rows: rows.length, cursor: lastId, completed }));
      if (completed) break;
      if (lastId === cursor) throw new Error('Source did not advance cursor');
      cursor = lastId;
    }
  }
}

async function refreshPhase(pass: number): Promise<Snapshot> {
  if (!run) throw new Error('Run not initialized');
  const phase = `refresh-${pass}`;
  if (run.phase !== phase || !run.phase_snapshot) {
    const before = await snapshot();
    const since = overlapSince(run.phase_snapshot?.maxUpdatedAt ?? run.source_snapshot.maxUpdatedAt ?? run.started_at.toISOString());
    await client.query('UPDATE import_runs SET phase=$2,phase_snapshot=$3::jsonb,updated_since=$4 WHERE id=$1', [run.id, phase, JSON.stringify(before), since]);
    run.phase = phase;
    run.phase_snapshot = before;
    run.updated_since = new Date(since);
  }
  await scan(phase, run.phase_snapshot, run.updated_since!.toISOString());
  return snapshot();
}

try {
  await client.connect();
  const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('nyc-service-pulse-august-2026')) AS acquired");
  if (!lock.rows[0].acquired) throw new Error('Another importer is running for this database');
  if (!args.includes('--new-run')) {
    const existing = await client.query(`SELECT * FROM import_runs WHERE mode=$1 ORDER BY started_at DESC LIMIT 1`, [mode]);
    if (existing.rows[0]?.status !== 'validated') run = existing.rows[0] as Run | undefined;
  }
  if (!run) {
    const before = await snapshot();
    if (!before.maxUpdatedAt) throw new Error('Source has no update watermark; cannot validate a mutable import');
    const startedAt = new Date();
    const id = randomUUID();
    const phase = mode === 'full' ? 'full' : 'refresh-1';
    let updatedSince: string | null = null;
    if (mode === 'refresh') {
      const previous = await client.query(`SELECT validation->'source'->>'maxUpdatedAt' AS watermark FROM import_runs WHERE status='validated' ORDER BY finished_at DESC LIMIT 1`);
      if (!previous.rows[0]?.watermark) throw new Error('Run a validated full import before refreshing');
      updatedSince = overlapSince(previous.rows[0].watermark);
    }
    await client.query(`INSERT INTO import_runs(id,mode,status,phase,started_at,updated_since,source_snapshot,phase_snapshot)
      VALUES($1,$2,'running',$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [id, mode, phase, startedAt, updatedSince, JSON.stringify(before), mode === 'refresh' ? JSON.stringify(before) : null]);
    run = { id, mode: mode as Run['mode'], phase, started_at: startedAt, updated_since: updatedSince ? new Date(updatedSince) : null,
      source_snapshot: before, phase_snapshot: mode === 'refresh' ? before : null, rows_processed: '0', batches_processed: 0 };
  } else {
    await client.query("UPDATE import_runs SET status='running',error=NULL,finished_at=NULL WHERE id=$1", [run.id]);
  }
  console.log(JSON.stringify({ runId: run.id, mode: run.mode, phase: run.phase, sourceRowsAtStart: run.source_snapshot.total, message: 'Checkpoints resume automatically; Ctrl-C safely stops after rollback/commit.' }));
  if (run.phase === 'full') await scan('full', run.source_snapshot, null);
  const firstPass = run.phase.startsWith('refresh-') ? Number(run.phase.split('-')[1]) : 1;
  let after: Snapshot | undefined;
  for (let pass = firstPass; pass <= 3; pass++) {
    after = await refreshPhase(pass);
    if (after.maxUpdatedAt === run.phase_snapshot!.maxUpdatedAt) break;
    console.log(`Source changed during refresh ${pass}; repeating the overlap window.`);
    if (pass === 3) throw new Error('Source kept changing through three refresh passes; retry later with --new-run');
  }
  if (!after) throw new Error('No source validation snapshot');
  let removed = 0;
  if (run.mode === 'full') {
    const seen = compareCounts(after, await localCounts(run.id));
    if (!seen.valid) throw new Error(`Full-pass membership differs from source; no rows deleted. Rerun with --new-run. ${seen.differences.join('; ')}`);
    const deletion = await client.query(`DELETE FROM service_requests r WHERE r.created_at >= '2026-08-01' AND r.created_at < '2026-09-01'
      AND NOT EXISTS(SELECT 1 FROM import_seen s WHERE s.run_id=$1 AND s.id=r.id)`, [run.id]);
    removed = deletion.rowCount ?? 0;
  }
  const local = await localCounts();
  const comparison = compareCounts(after, local);
  if (!comparison.valid) throw new Error(`Counts do not reconcile; run --mode=full --new-run. ${comparison.differences.join('; ')}`);
  const quality = await client.query(`SELECT count(*)::int AS total,count(DISTINCT id)::int AS distinct_ids,
    count(*) FILTER(WHERE geom IS NULL)::int AS missing_coordinates,
    count(*) FILTER(WHERE status='Closed')::int AS closed,
    count(*) FILTER(WHERE status='Closed' AND created_at IS NOT NULL AND closed_at >= created_at)::int AS valid_closed_intervals,
    count(*) FILTER(WHERE 'negative_closure_interval'=ANY(quality_flags))::int AS negative_intervals,
    count(*) FILTER(WHERE 'closed_missing_closed_date'=ANY(quality_flags))::int AS closed_missing_date,
    count(*) FILTER(WHERE 'nonclosed_with_closed_date'=ANY(quality_flags))::int AS nonclosed_with_date,
    max(source_updated_at) AS max_source_updated_at FROM service_requests`);
  await client.query('ANALYZE service_requests');
  const validation = { valid: true, source: after, local, quality: quality.rows[0], removed,
    durationSeconds: (Date.now() - run.started_at.getTime()) / 1000, responseBytesThisProcess: responseBytes,
    sourceRequestsThisProcess: requests, checkedAt: new Date().toISOString(),
    scope: 'August 2026 created_date cohort; floating timestamps preserved. Counts/daily distinct IDs and stable update watermark verified, not an immutable source snapshot.' };
  await client.query("UPDATE import_runs SET status='validated',finished_at=now(),validation=$2::jsonb,error=NULL WHERE id=$1", [run.id, JSON.stringify(validation)]);
  console.log(JSON.stringify({ runId: run.id, ...validation }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (run) await client.query('UPDATE import_runs SET status=$2,error=$3,finished_at=now() WHERE id=$1', [run.id, interrupted ? 'interrupted' : 'failed', message]).catch(() => undefined);
  console.error(message);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  await client.end().catch(() => undefined);
}
