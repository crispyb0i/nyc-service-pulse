import type { PoolClient } from "pg";
import { withReadSnapshot } from "./db";
import { buildPredicate, dateSeries, encodeCursor } from "./filters";
import {
  PAGE_SIZE,
  type Filters,
  type ImportStatus,
  type ProblemsResponse,
  type PulseQuery,
  type PulseResponse,
  type ServiceRequest,
} from "./types";

export const SOURCE_URL = "https://data.cityofnewyork.us/resource/erm2-nwe9.json";
const VALID_CLOSURE = "status = 'Closed' AND closed_at IS NOT NULL AND closed_at >= created_at";

type SummaryRow = {
  total: number;
  closed: number;
  medianClosureHours: number | null;
  validClosureCount: number;
  missingCoordinates: number;
};
type MetaRow = {
  importRunId: string | null;
  importStatus: ImportStatus;
  lastValidatedAt: Date | null;
  dataFetchedAt: Date | null;
  latestSourceUpdateAt: Date | null;
};

export async function queryPulse(client: Pick<PoolClient, "query">, query: PulseQuery): Promise<PulseResponse> {
  const filters: Filters = { from: query.from, to: query.to, problem: query.problem };
  const where = buildPredicate(filters);
  const summaryResult = await client.query<SummaryRow>(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'Closed')::int AS closed,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (closed_at - created_at)) / 3600.0)
             FILTER (WHERE ${VALID_CLOSURE}) AS "medianClosureHours",
           count(*) FILTER (WHERE ${VALID_CLOSURE})::int AS "validClosureCount",
           count(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL)::int AS "missingCoordinates"
    FROM service_requests WHERE ${where.sql}`, where.values);
  const dailyResult = await client.query<{ date: string; count: number }>(`
    SELECT created_at::date::text AS date, count(*)::int AS count
    FROM service_requests WHERE ${where.sql}
    GROUP BY created_at::date ORDER BY created_at::date`, where.values);

  const pageValues = [...where.values];
  let pageWhere = where.sql;
  if (query.cursor) {
    pageValues.push(query.cursor.createdAt, query.cursor.id);
    pageWhere += ` AND (created_at, id) < ($${pageValues.length - 1}::timestamp, $${pageValues.length}::text)`;
  }
  pageValues.push(PAGE_SIZE + 1);
  const pageResult = await client.query<ServiceRequest>(`
    SELECT id,
           to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt",
           to_char(closed_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "closedAt",
           status, agency, problem, detail, borough, quality_flags AS "qualityFlags"
    FROM service_requests WHERE ${pageWhere}
    ORDER BY created_at DESC, id DESC LIMIT $${pageValues.length}`, pageValues);

  const metaResult = await client.query<MetaRow>(`
    SELECT (SELECT id FROM import_runs ORDER BY started_at DESC LIMIT 1) AS "importRunId",
           COALESCE((SELECT status FROM import_runs ORDER BY started_at DESC LIMIT 1), 'not_started') AS "importStatus",
           (SELECT max(finished_at) FROM import_runs WHERE status = 'validated') AS "lastValidatedAt",
           max(fetched_at) AS "dataFetchedAt",
           max(source_updated_at) AS "latestSourceUpdateAt"
    FROM service_requests`);

  const summary = summaryResult.rows[0];
  const byDate = new Map(dailyResult.rows.map((row) => [row.date, row.count]));
  const requests = pageResult.rows.slice(0, PAGE_SIZE);
  const last = requests.at(-1);
  const meta = metaResult.rows[0];
  return {
    summary: {
      ...summary,
      closedPercent: summary.total ? (summary.closed / summary.total) * 100 : 0,
      medianClosureHours: summary.medianClosureHours === null ? null : Number(summary.medianClosureHours),
    },
    daily: dateSeries(filters.from, filters.to).map((date) => ({ date, count: byDate.get(date) ?? 0 })),
    requests,
    nextCursor: pageResult.rows.length > PAGE_SIZE && last
      ? encodeCursor({ createdAt: last.createdAt, id: last.id }, filters) : null,
    meta: {
      filters,
      pageSize: PAGE_SIZE,
      source: SOURCE_URL,
      timestampConvention: "Source floating timestamps preserved; displayed as New York local time by publisher-local assumption. No UTC conversion applied.",
      dataFetchedAt: meta.dataFetchedAt?.toISOString() ?? null,
      latestSourceUpdateAt: meta.latestSourceUpdateAt?.toISOString() ?? null,
      importStatus: meta.importStatus,
      importRunId: meta.importRunId,
      lastValidatedAt: meta.lastValidatedAt?.toISOString() ?? null,
      generatedAt: new Date().toISOString(),
    },
  };
}

export function readPulse(query: PulseQuery): Promise<PulseResponse> {
  return withReadSnapshot((client) => queryPulse(client, query));
}

export async function readProblems(filters: Filters): Promise<ProblemsResponse> {
  const where = buildPredicate({ ...filters, problem: null });
  return withReadSnapshot(async (client) => {
    const result = await client.query<{ name: string; count: number }>(`
      SELECT problem AS name, count(*)::int AS count
      FROM service_requests WHERE ${where.sql} AND problem IS NOT NULL
      GROUP BY problem ORDER BY count(*) DESC, problem ASC`, where.values);
    return { problems: result.rows };
  });
}
