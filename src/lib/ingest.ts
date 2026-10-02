export const SOURCE_URL = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json';
export const COHORT_START = '2026-08-01';
export const COHORT_END = '2026-09-01';
export const SOURCE_FIELDS = 'unique_key,created_date,closed_date,status,agency,complaint_type,descriptor,borough,latitude,longitude,:updated_at as source_updated_at';
export const COHORT_WHERE = `created_date >= '${COHORT_START}T00:00:00' AND created_date < '${COHORT_END}T00:00:00'`;

export type SourceRow = Record<string, string | number | null | undefined>;
export type NormalizedRow = {
  id: string;
  created_at: string | null;
  closed_at: string | null;
  created_raw: string | null;
  closed_raw: string | null;
  status: string;
  agency: string;
  problem: string;
  detail: string | null;
  borough: string | null;
  latitude: number | null;
  longitude: number | null;
  source_updated_at: string | null;
  fetched_at: string;
  quality_flags: string[];
};

export function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** Validate without letting Date.parse normalize invalid calendar dates or add a timezone. */
export function floatingTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  const [y, m, d, h, min, s] = match.slice(1, 7).map(Number);
  if (y < 1000 || m < 1 || m > 12 || d < 1 || h > 23 || min > 59 || s > 59) return null;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth ? value : null;
}

/** System :updated_at is an actual instant; floating created/closed dates are not. */
export function sourceInstant(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  let milliseconds: number;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const numeric = Number(value);
    milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
  } else {
    const text = String(value);
    milliseconds = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);
  }
  const instant = new Date(milliseconds);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function sortableFloating(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(6, '0')}`;
}

export function normalizeRow(row: SourceRow, fetchedAt: string): NormalizedRow {
  const id = nullableText(row.unique_key);
  if (!id || !/^\d+$/.test(id)) throw new Error('Source row has no valid numeric-text unique_key; refusing to checkpoint past it');
  const createdRaw = nullableText(row.created_date);
  const closedRaw = nullableText(row.closed_date);
  const created = floatingTimestamp(createdRaw);
  const closed = floatingTimestamp(closedRaw);
  const status = nullableText(row.status) ?? 'Unknown';
  const quality: string[] = [];
  for (const [field, name] of [['status', 'status'], ['agency', 'agency'], ['complaint_type', 'problem']]) {
    if (!nullableText(row[field])) quality.push(`missing_${name}`);
  }
  if (!created) quality.push('invalid_created_date');
  if (closedRaw && !closed) quality.push('invalid_closed_date');
  if (status === 'Closed' && !closedRaw) quality.push('closed_missing_closed_date');
  if (status !== 'Closed' && closedRaw) quality.push('nonclosed_with_closed_date');
  if (created && closed && sortableFloating(closed) < sortableFloating(created)) quality.push('negative_closure_interval');
  const latitudeRaw = nullableText(row.latitude);
  const longitudeRaw = nullableText(row.longitude);
  let latitude = latitudeRaw === null ? null : Number(latitudeRaw);
  let longitude = longitudeRaw === null ? null : Number(longitudeRaw);
  if (latitude === null || longitude === null) {
    quality.push('missing_coordinates');
    latitude = null;
    longitude = null;
  } else if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    quality.push('invalid_coordinates');
    latitude = null;
    longitude = null;
  }
  const sourceUpdated = sourceInstant(row.source_updated_at);
  if (!sourceUpdated) quality.push('missing_or_invalid_source_updated_at');
  return {
    id, created_at: created, closed_at: closed, created_raw: createdRaw, closed_raw: closedRaw,
    status, agency: nullableText(row.agency) ?? 'Unknown', problem: nullableText(row.complaint_type) ?? 'Unknown',
    detail: nullableText(row.descriptor), borough: nullableText(row.borough),
    latitude, longitude, source_updated_at: sourceUpdated, fetched_at: fetchedAt, quality_flags: quality,
  };
}

export function augustDays(): string[] {
  return Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
}

export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function quote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export function pageUrl(day: string, lastId: string | null, limit: number, updatedSince?: string | null, minimumId?: string | null, maximumId?: string | null): string {
  if (!augustDays().includes(day)) throw new Error('Importer is restricted to August 2026');
  if (!Number.isInteger(limit) || limit < 100 || limit > 5000) throw new Error('Page size must be 100–5000');
  if (lastId !== null && !/^\d+$/.test(lastId)) throw new Error('Invalid cursor');
  const predicates = [`created_date >= '${day}T00:00:00'`, `created_date < '${nextDay(day)}T00:00:00'`];
  if (lastId !== null) predicates.push(`unique_key > ${quote(lastId)}`);
  else if (minimumId && /^\d+$/.test(minimumId)) predicates.push(`unique_key >= ${quote(minimumId)}`);
  if (maximumId && /^\d+$/.test(maximumId)) predicates.push(`unique_key <= ${quote(maximumId)}`);
  if (updatedSince) predicates.push(`:updated_at >= ${quote(updatedSince)}`);
  const url = new URL(SOURCE_URL);
  url.search = new URLSearchParams({ $select: SOURCE_FIELDS, $where: predicates.join(' AND '), $order: 'unique_key ASC', $limit: String(limit) }).toString();
  return url.toString();
}

export function normalizePage(rows: SourceRow[], lastId: string | null, fetchedAt: string): NormalizedRow[] {
  const dedup = new Map<string, NormalizedRow>();
  let previous = lastId;
  for (const source of rows) {
    const row = normalizeRow(source, fetchedAt);
    const current = row.id;
    if (previous !== null && current < previous) throw new Error('Source page is not in stable unique_key order');
    if (lastId !== null && current <= lastId) throw new Error('Source page did not advance the cursor');
    previous = current;
    dedup.set(row.id, row);
  }
  return [...dedup.values()];
}

export type DayCount = { day: string; count: number; distinct: number; minimumId?: string | null; maximumId?: string | null };
export type Snapshot = { fetchedAt: string; total: number; distinct: number; maxUpdatedAt: string | null; days: DayCount[] };

export function compareCounts(source: Snapshot, local: DayCount[]): { valid: boolean; differences: string[] } {
  const differences: string[] = [];
  const localByDay = new Map(local.map(row => [row.day, row]));
  const sourceByDay = new Map(source.days.map(row => [row.day, row]));
  for (const day of augustDays()) {
    const expected = sourceByDay.get(day) ?? { count: 0, distinct: 0 };
    const actual = localByDay.get(day) ?? { count: 0, distinct: 0 };
    if (expected.count !== expected.distinct) differences.push(`${day}: source contains duplicate IDs`);
    if (expected.count !== actual.count || expected.distinct !== actual.distinct) differences.push(`${day}: source ${expected.count}/${expected.distinct}, local ${actual.count}/${actual.distinct}`);
  }
  if (source.total !== source.distinct) differences.push('Source total differs from distinct IDs');
  return { valid: differences.length === 0, differences };
}

export function overlapSince(instant: string): string {
  return new Date(Date.parse(instant) - 5 * 60_000).toISOString();
}

export function localDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required; run with the project .env.local');
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/nyc_service_pulse') {
    throw new Error('Importer/migration requires local database nyc_service_pulse; refusing another database');
  }
  return value;
}
