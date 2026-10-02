import { createHash } from "node:crypto";
import { COHORT, type Filters, type PulseQuery, type RequestCursor } from "./types";

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterError";
  }
}

function date(value: string, label: string): string {
  if (!/^2026-08-(0[1-9]|[12]\d|3[01])$/.test(value)) {
    throw new FilterError(`${label} must be a date within August 2026 (YYYY-MM-DD).`);
  }
  return value;
}

function fingerprint(filters: Filters, scope?: string): string {
  return createHash("sha256")
    .update(JSON.stringify(scope ? [filters.from, filters.to, filters.problem, scope] : [filters.from, filters.to, filters.problem]))
    .digest("base64url");
}

export function encodeCursor(cursor: RequestCursor, filters: Filters, scope?: string): string {
  return Buffer.from(JSON.stringify({ v: 1, t: cursor.createdAt, i: cursor.id, f: fingerprint(filters, scope) })).toString("base64url");
}

export function decodeCursor(raw: string, filters: Filters, scope?: string): RequestCursor {
  try {
    if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const data: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!data || typeof data !== "object") throw new Error();
    const value = data as Record<string, unknown>;
    if (value.v !== 1 || value.f !== fingerprint(filters, scope)
      || typeof value.t !== "string" || typeof value.i !== "string"
      || !/^2026-08-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(value.t)
      || value.t.slice(0, 10) < filters.from || value.t.slice(0, 10) > filters.to
      || value.i.length < 1 || value.i.length > 100 || /[\u0000-\u001f]/.test(value.i)) throw new Error();
    return { createdAt: value.t, id: value.i };
  } catch {
    throw new FilterError("The page cursor is invalid or belongs to different filters. Start from the first page.");
  }
}

export function parseFilters(params: URLSearchParams, allowCursor = true): PulseQuery {
  const allowed = new Set(allowCursor ? ["from", "to", "problem", "cursor"] : ["from", "to"]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) throw new FilterError(`Unsupported query parameter: ${key}.`);
    if (params.getAll(key).length > 1) throw new FilterError(`Supply ${key} only once.`);
  }
  const from = date(params.get("from") ?? COHORT.from, "From");
  const to = date(params.get("to") ?? COHORT.to, "To");
  if (from > to) throw new FilterError("From must be on or before To.");
  const problem = params.get("problem") || null;
  if (problem && (problem.length > 250 || !problem.trim() || /[\u0000-\u001f]/.test(problem))) {
    throw new FilterError("Problem must be a nonempty complaint type of at most 250 characters.");
  }
  const filters: Filters = { from, to, problem };
  const rawCursor = params.get("cursor");
  if (params.has("cursor") && !rawCursor) throw new FilterError("The page cursor cannot be empty.");
  return { ...filters, cursor: rawCursor ? decodeCursor(rawCursor, filters) : null };
}

/** One predicate for totals, chart, and rows; the end date is inclusive in the UI. */
export function buildPredicate(filters: Filters): { sql: string; values: unknown[] } {
  const values: unknown[] = [`${filters.from}T00:00:00`, `${filters.to}T00:00:00`];
  let sql = "created_at >= $1::timestamp AND created_at < $2::timestamp + interval '1 day'";
  if (filters.problem !== null) {
    values.push(filters.problem);
    sql += ` AND problem = $${values.length}`;
  }
  return { sql, values };
}

export function dateSeries(from: string, to: string): string[] {
  const dates: string[] = [];
  // Dates here are calendar labels, not converted source timestamps.
  for (let day = Number(from.slice(-2)); day <= Number(to.slice(-2)); day++) {
    dates.push(`2026-08-${String(day).padStart(2, "0")}`);
  }
  return dates;
}
