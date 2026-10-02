import type { Client } from 'pg';
import type { NormalizedRow } from './ingest';

/** The page and its checkpoint commit together; retrying a page cannot duplicate IDs. */
export async function commitPage(client: Client, options: {
  runId: string; phase: string; day: string; rows: NormalizedRow[];
  lastId: string | null; completed: boolean; trackMembership: boolean;
}): Promise<void> {
  const { runId, phase, day, rows, lastId, completed, trackMembership } = options;
  await client.query('BEGIN');
  try {
    if (rows.length) {
      await client.query(`CREATE TEMP TABLE ingest_page ON COMMIT DROP AS
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(
          id text, created_at timestamp, closed_at timestamp, created_raw text, closed_raw text,
          status text, agency text, problem text, detail text, borough text, latitude double precision,
          longitude double precision, source_updated_at timestamptz, fetched_at timestamptz, quality_flags text[])`, [JSON.stringify(rows)]);
      await client.query(`INSERT INTO service_requests
        (id,created_at,closed_at,created_raw,closed_raw,status,agency,problem,detail,borough,
         latitude,longitude,geom,source_updated_at,fetched_at,quality_flags,import_run_id)
        SELECT id,created_at,closed_at,created_raw,closed_raw,status,agency,problem,detail,borough,
          latitude,longitude,CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL
          THEN ST_SetSRID(ST_MakePoint(longitude,latitude),4326) ELSE NULL END,
          source_updated_at,fetched_at,quality_flags,$1::uuid FROM ingest_page
        ON CONFLICT (id) DO UPDATE SET
          created_at=EXCLUDED.created_at,closed_at=EXCLUDED.closed_at,created_raw=EXCLUDED.created_raw,
          closed_raw=EXCLUDED.closed_raw,status=EXCLUDED.status,agency=EXCLUDED.agency,
          problem=EXCLUDED.problem,detail=EXCLUDED.detail,borough=EXCLUDED.borough,
          latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,geom=EXCLUDED.geom,
          source_updated_at=EXCLUDED.source_updated_at,fetched_at=EXCLUDED.fetched_at,
          quality_flags=EXCLUDED.quality_flags,import_run_id=EXCLUDED.import_run_id
        WHERE service_requests.source_updated_at IS NULL
          OR EXCLUDED.source_updated_at >= service_requests.source_updated_at`, [runId]);
      if (trackMembership) {
        await client.query(`INSERT INTO import_seen (run_id,id,day)
          SELECT $1::uuid,id,COALESCE(created_at::date,$2::date) FROM ingest_page
          ON CONFLICT (run_id,id) DO UPDATE SET day=EXCLUDED.day`, [runId, day]);
      }
    }
    await client.query(`INSERT INTO import_checkpoints (run_id,phase,day,last_id,completed,rows_processed)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id,phase,day) DO UPDATE SET
      last_id=EXCLUDED.last_id,completed=EXCLUDED.completed,
      rows_processed=import_checkpoints.rows_processed+EXCLUDED.rows_processed,updated_at=now()`,
    [runId, phase, day, lastId, completed, rows.length]);
    await client.query(`UPDATE import_runs SET rows_processed=rows_processed+$2,
      batches_processed=batches_processed+1 WHERE id=$1`, [runId, rows.length]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
