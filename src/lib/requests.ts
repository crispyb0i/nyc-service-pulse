import type { PoolClient } from "pg";
import { withReadSnapshot } from "./db";
import { buildPredicate, decodeCursor, encodeCursor, FilterError, parseFilters } from "./filters";
import { parseMapQuery } from "./map";
import type { MapBounds } from "./map-types";
import { COHORT, PAGE_SIZE, type Filters, type RequestCursor } from "./types";
import type { LocatedRequest, RequestPage } from "./request-types";

export type RequestsQuery = { filters: Filters; bounds: MapBounds | null; queryBounds: MapBounds | null; cursor: RequestCursor | null; direction: "next" | "previous" };
const fields = `id,to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt",
  to_char(closed_at,'YYYY-MM-DD"T"HH24:MI:SS.US') AS "closedAt",
  status,agency,problem,detail,borough,quality_flags AS "qualityFlags",latitude,longitude`;

export function parseRequestsQuery(params: URLSearchParams): RequestsQuery {
  const allowed = new Set(["from", "to", "problem", "cursor", "direction", "west", "south", "east", "north"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new FilterError(`Unsupported or repeated query parameter: ${key}.`);
  }
  const shared = new URLSearchParams();
  for (const key of ["from", "to", "problem"]) if (params.has(key)) shared.set(key, params.get(key)!);
  const { from, to, problem } = parseFilters(shared);
  const filters = { from, to, problem };
  let bounds: MapBounds | null = null;
  let queryBounds: MapBounds | null = null;
  if (["west", "south", "east", "north"].some((key) => params.has(key))) {
    for (const key of ["west", "south", "east", "north"]) if (params.has(key)) shared.set(key, params.get(key)!);
    shared.set("zoom", "10");
    ({ bounds, queryBounds } = parseMapQuery(shared));
  }
  const direction = params.get("direction") ?? "next";
  if (direction !== "next" && direction !== "previous") throw new FilterError("Direction must be next or previous.");
  if (params.has("cursor") && !params.get("cursor")) throw new FilterError("The page cursor cannot be empty.");
  if (direction === "previous" && !params.has("cursor")) throw new FilterError("Previous requires a cursor.");
  const cursor = params.has("cursor") ? decodeCursor(params.get("cursor")!, filters, bounds ? JSON.stringify(bounds) : undefined) : null;
  return { filters, bounds, queryBounds, direction, cursor };
}

/** A 51-row keyset query only: page turns never execute summary/chart aggregates. */
export async function queryRequests(client: Pick<PoolClient, "query">, query: RequestsQuery): Promise<RequestPage> {
  const { filters, bounds, queryBounds, cursor, direction } = query;
  const empty: RequestPage = { requests: [], nextCursor: null, previousCursor: null, filters, bounds, generatedAt: new Date().toISOString() };
  if (bounds && !queryBounds) return empty;
  const where = buildPredicate(filters);
  if (queryBounds) {
    const first = where.values.length + 1;
    where.values.push(...queryBounds);
    where.sql += ` AND geom IS NOT NULL AND geom && ST_MakeEnvelope($${first},$${first + 1},$${first + 2},$${first + 3},4326)
      AND longitude >= $${first} AND longitude <= $${first + 2} AND latitude >= $${first + 1} AND latitude <= $${first + 3}`;
  }
  if (cursor) {
    where.values.push(cursor.createdAt, cursor.id);
    where.sql += ` AND (created_at,id) ${direction === "previous" ? ">" : "<"} ($${where.values.length - 1}::timestamp,$${where.values.length}::text)`;
  }
  where.values.push(PAGE_SIZE + 1);
  const order = direction === "previous" ? "ASC" : "DESC";
  const result = await client.query<LocatedRequest>(`SELECT ${fields} FROM service_requests WHERE ${where.sql}
    ORDER BY created_at ${order},id ${order} LIMIT $${where.values.length}`, where.values);
  const requests = result.rows.slice(0, PAGE_SIZE);
  if (direction === "previous") requests.reverse();
  const first = requests[0];
  const last = requests.at(-1);
  const scope = bounds ? JSON.stringify(bounds) : undefined;
  return { ...empty, requests,
    nextCursor: last && (direction === "previous" ? cursor !== null : result.rows.length > PAGE_SIZE) ? encodeCursor(last, filters, scope) : null,
    previousCursor: first && (direction === "previous" ? result.rows.length > PAGE_SIZE : cursor !== null) ? encodeCursor(first, filters, scope) : null,
  };
}

export function readRequests(query: RequestsQuery) {
  return withReadSnapshot((client) => queryRequests(client, query));
}

export function parseRequestId(params: URLSearchParams): string {
  if ([...params.keys()].some((key) => key !== "id") || params.getAll("id").length !== 1) throw new FilterError("Supply one request ID.");
  const id = params.get("id")!;
  if (!id.trim() || id.length > 100 || /[\u0000-\u001f]/.test(id)) throw new FilterError("Invalid request ID.");
  return id;
}

export async function queryRequest(client: Pick<PoolClient, "query">, id: string): Promise<{ request: LocatedRequest | null }> {
  const result = await client.query<LocatedRequest>(`SELECT ${fields} FROM service_requests
    WHERE id=$1 AND created_at >= $2::timestamp AND created_at < $3::timestamp + interval '1 day'`, [id, COHORT.from, COHORT.to]);
  return { request: result.rows[0] ?? null };
}

export function readRequest(id: string) { return withReadSnapshot((client) => queryRequest(client, id)); }
