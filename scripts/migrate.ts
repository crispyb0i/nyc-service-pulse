import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { localDatabaseUrl } from '../src/lib/ingest';

const client = new pg.Client({ connectionString: localDatabaseUrl() });
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(await readFile(path.join(process.cwd(), 'db/schema.sql'), 'utf8'));
  await client.query('COMMIT');
  console.log('Schema ready: local nyc_service_pulse with PostGIS.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
