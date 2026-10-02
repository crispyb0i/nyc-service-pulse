import assert from 'node:assert/strict';
import test from 'node:test';
import { augustDays, compareCounts, floatingTimestamp, normalizePage, normalizeRow, overlapSince, pageUrl, sourceInstant, type Snapshot } from '../src/lib/ingest';

const fetched = '2026-10-01T22:00:00.000Z';
const source = { unique_key: '69903445', created_date: '2026-08-01T23:45:00.123456',
  closed_date: '2026-08-02T00:45:00.123456', status: 'Closed', agency: 'NYPD',
  complaint_type: 'Noise', descriptor: 'Loud music', borough: 'BROOKLYN', latitude: '40.7', longitude: '-73.9',
  source_updated_at: '2026-10-01T18:01:49.042Z' };

test('floating source dates keep their exact clock and microseconds', () => {
  assert.equal(floatingTimestamp(source.created_date), source.created_date);
  assert.equal(floatingTimestamp('2026-02-29T10:00:00'), null);
  assert.equal(floatingTimestamp('2026-08-01T24:00:00'), null);
  assert.equal(floatingTimestamp('2026-08-01T23:00:00Z'), null);
  const row = normalizeRow(source, fetched);
  assert.equal(row.created_at, source.created_date);
  assert.equal(row.created_raw, source.created_date);
  assert.deepEqual(row.quality_flags, []);
});

test('invalid dates and coordinates survive as raw values with quality flags', () => {
  const row = normalizeRow({ ...source, closed_date: 'not-a-date', latitude: undefined }, fetched);
  assert.equal(row.closed_at, null);
  assert.equal(row.closed_raw, 'not-a-date');
  assert.equal(row.latitude, null);
  assert.equal(row.longitude, null);
  assert.deepEqual(row.quality_flags, ['invalid_closed_date', 'missing_coordinates']);
  const negative = normalizeRow({ ...source, closed_date: '2026-08-01T23:45:00.123455' }, fetched);
  assert.ok(negative.quality_flags.includes('negative_closure_interval'));
  const nonclosed = normalizeRow({ ...source, status: 'Open' }, fetched);
  assert.ok(nonclosed.quality_flags.includes('nonclosed_with_closed_date'));
  const missingClosed = normalizeRow({ ...source, closed_date: undefined }, fetched);
  assert.ok(missingClosed.quality_flags.includes('closed_missing_closed_date'));
});

test('missing labels have filterable Unknown values and explicit flags', () => {
  const row = normalizeRow({ ...source, complaint_type: undefined, agency: undefined, status: undefined }, fetched);
  assert.equal(row.problem, 'Unknown');
  assert.equal(row.agency, 'Unknown');
  assert.equal(row.status, 'Unknown');
  assert.ok(row.quality_flags.includes('missing_problem'));
});

test('unique_key text ordering, deduplication, and resume cursor cannot skip a bad page', () => {
  const rows = normalizePage([{ ...source, unique_key: '10' }, { ...source, unique_key: '10', descriptor: 'latest' }, { ...source, unique_key: '2' }], null, fetched);
  assert.deepEqual(rows.map(row => row.id), ['10', '2']);
  assert.equal(rows[0].detail, 'latest');
  assert.throws(() => normalizePage([{ ...source, unique_key: '10' }], '10', fetched), /did not advance/);
  assert.throws(() => normalizePage([{ ...source, unique_key: '2' }, { ...source, unique_key: '10' }], null, fetched), /stable unique_key order/);
  assert.throws(() => normalizePage([{ ...source, unique_key: '' }], null, fetched), /unique_key/);
});

test('daily request is bounded, keyset-resumable, and uses source update overlap', () => {
  const url = new URL(pageUrl('2026-08-31', '69903445', 5000, fetched, '69900000', '71000000'));
  assert.equal(url.searchParams.get('$limit'), '5000');
  assert.equal(url.searchParams.get('$order'), 'unique_key ASC');
  const where = url.searchParams.get('$where')!;
  assert.ok(where.includes("created_date < '2026-09-01T00:00:00'"));
  assert.ok(where.includes("unique_key > '69903445'"));
  assert.ok(where.includes("unique_key <= '71000000'"));
  assert.ok(where.includes(`:updated_at >= '${fetched}'`));
  assert.ok(new URL(pageUrl('2026-08-01', null, 5000, null, '69903445')).searchParams.get('$where')!.includes("unique_key >= '69903445'"));
  assert.throws(() => pageUrl('2026-09-01', null, 5000), /August/);
  assert.throws(() => pageUrl('2026-08-01', null, 5001), /Page size/);
  assert.throws(() => pageUrl('2026-08-01', "'; DROP TABLE x", 5000), /cursor/);
  assert.equal(overlapSince(fetched), '2026-10-01T21:55:00.000Z');
  assert.equal(augustDays().length, 31);
});

test('daily reconciliation rejects missing IDs, duplicates, and shifted dates', () => {
  const snapshot: Snapshot = { fetchedAt: fetched, total: 3, distinct: 3, maxUpdatedAt: fetched,
    days: [{ day: '2026-08-01', count: 2, distinct: 2 }, { day: '2026-08-02', count: 1, distinct: 1 }] };
  assert.equal(compareCounts(snapshot, snapshot.days).valid, true);
  assert.equal(compareCounts(snapshot, [{ day: '2026-08-01', count: 1, distinct: 1 }, { day: '2026-08-02', count: 2, distinct: 2 }]).valid, false);
  assert.equal(compareCounts({ ...snapshot, distinct: 2 }, snapshot.days).valid, false);
  assert.equal(compareCounts(snapshot, []).valid, false);
});

test('system updated_at supports timestamp and epoch formats', () => {
  assert.equal(sourceInstant('2026-10-01T18:01:49.042Z'), '2026-10-01T18:01:49.042Z');
  assert.equal(sourceInstant(0), '1970-01-01T00:00:00.000Z');
  assert.equal(sourceInstant('garbage'), null);
  assert.equal(sourceInstant('99999999999999999999999'), null);
});
