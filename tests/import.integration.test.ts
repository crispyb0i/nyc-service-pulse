import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { normalizeRow } from '../src/lib/ingest';
import { commitPage } from '../src/lib/ingest-store';

const connectionString = process.env.TEST_DATABASE_URL;
test('PostgreSQL page upsert, rollback, resume, dedup and stale-source protection', { skip: !connectionString }, async () => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Temporary tables shadow public names on this connection only. Internal page
    // commits preserve them, and closing the connection removes every fixture.
    for (const table of ['import_runs', 'service_requests', 'import_checkpoints', 'import_seen']) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    const runId = randomUUID();
    await client.query("INSERT INTO import_runs(id,mode,status) VALUES($1,'full','running')", [runId]);
    const source = { unique_key: '69903445', created_date: '2026-08-01T12:00:00.123456', status: 'Open', agency: 'TEST', complaint_type: 'Noise', source_updated_at: '2026-10-01T12:00:00Z' };
    const row = normalizeRow(source, '2026-10-01T12:01:00Z');
    const page = { runId, phase: 'full', day: '2026-08-01', rows: [row], lastId: row.id, completed: false, trackMembership: true };
    await commitPage(client, page);
    await commitPage(client, page);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM service_requests')).rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM import_seen')).rows[0].n, 1);
    assert.equal((await client.query('SELECT last_id FROM import_checkpoints')).rows[0].last_id, row.id);

    const second = normalizeRow({ ...source, unique_key: '69903446', source_updated_at: '2026-10-01T13:00:00Z' }, '2026-10-01T13:01:00Z');
    // Invalid checkpoint day fails after INSERT; the entire page must roll back.
    await assert.rejects(commitPage(client, { ...page, day: 'invalid', rows: [second], lastId: second.id }));
    assert.equal((await client.query('SELECT count(*)::int AS n FROM service_requests')).rows[0].n, 1);
    assert.equal((await client.query('SELECT last_id FROM import_checkpoints')).rows[0].last_id, row.id);
    await commitPage(client, { ...page, rows: [second], lastId: second.id, completed: true });
    assert.equal((await client.query('SELECT count(*)::int AS n FROM service_requests')).rows[0].n, 2);
    assert.equal((await client.query('SELECT completed FROM import_checkpoints')).rows[0].completed, true);

    const stale = normalizeRow({ ...source, unique_key: second.id, status: 'Closed', source_updated_at: '2026-10-01T11:00:00Z' }, '2026-10-01T14:00:00Z');
    await commitPage(client, { ...page, phase: 'refresh-1', rows: [stale], lastId: stale.id, completed: true });
    assert.equal((await client.query('SELECT status FROM service_requests WHERE id=$1', [second.id])).rows[0].status, 'Open');
  } finally { await client.end(); }
});
