import type { PoolClient } from "pg";
import { withReadSnapshot } from "./db";
import { buildPredicate, FilterError, parseFilters } from "./filters";
import {
  MAP_STUDY_BOUNDS, MAX_GRID_FEATURES, MAX_POINT_FEATURES,
  type MapBounds, type MapFeature, type MapResponse,
} from "./map-types";
import type { Filters, ServiceRequest } from "./types";

const EARTH_RADIUS = 6_378_137;
const MERCATOR_LATITUDE = 85.05112878;
export type MapQuery = { filters: Filters; bounds: MapBounds; queryBounds: MapBounds | null; zoom: number };

function finiteNumber(params: URLSearchParams, key: string): number {
  const value = params.get(key);
  if (value === null || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))) {
    throw new FilterError(`${key} must be a finite number.`);
  }
  return Number(value);
}

export function clipBounds(bounds: MapBounds, clip: MapBounds = MAP_STUDY_BOUNDS): MapBounds | null {
  const intersection: MapBounds = [Math.max(bounds[0], clip[0]), Math.max(bounds[1], clip[1]), Math.min(bounds[2], clip[2]), Math.min(bounds[3], clip[3])];
  return intersection[0] > intersection[2] || intersection[1] > intersection[3] ? null : intersection;
}

export function parseMapQuery(params: URLSearchParams): MapQuery {
  const keys = new Set(["from", "to", "problem", "west", "south", "east", "north", "zoom"]);
  for (const key of params.keys()) {
    if (!keys.has(key)) throw new FilterError(`Unsupported query parameter: ${key}.`);
    if (params.getAll(key).length !== 1) throw new FilterError(`Supply ${key} only once.`);
  }
  const shared = new URLSearchParams();
  for (const key of ["from", "to", "problem"]) if (params.has(key)) shared.set(key, params.get(key)!);
  const { from, to, problem } = parseFilters(shared);
  const bounds: MapBounds = [finiteNumber(params, "west"), finiteNumber(params, "south"), finiteNumber(params, "east"), finiteNumber(params, "north")];
  const [west, south, east, north] = bounds;
  if (west < -180 || east > 180 || west >= east || south < -MERCATOR_LATITUDE || north > MERCATOR_LATITUDE || south >= north) {
    throw new FilterError("Bounds must be an ascending WGS84 rectangle within longitude ±180 and Web Mercator latitude ±85.05112878.");
  }
  const zoom = finiteNumber(params, "zoom");
  if (zoom < 9 || zoom > 18.5) throw new FilterError("Zoom must be between 9 and 18.5.");
  return { filters: { from, to, problem }, bounds, queryBounds: clipBounds(bounds), zoom };
}

export function project(longitude: number, latitude: number): [number, number] {
  return [EARTH_RADIUS * longitude * Math.PI / 180, EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360))];
}

function unproject(x: number, y: number): [number, number] {
  return [x / EARTH_RADIUS * 180 / Math.PI, (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180 / Math.PI];
}

/** Globally anchored, power-of-two cells stay stable during pans at a fixed scale. */
export function gridCellSize(bounds: MapBounds, zoom: number): number {
  const [west, south] = project(bounds[0], bounds[1]);
  const [east, north] = project(bounds[2], bounds[3]);
  let size = 2 ** (23 - Math.floor(zoom));
  // Two extra cells per axis bound either edge's partially intersected snapped cell,
  // including exact-edge points. Never truncate the database's grouped results.
  while ((Math.ceil((east - west) / size) + 2) * (Math.ceil((north - south) / size) + 2) > MAX_GRID_FEATURES) size *= 2;
  return size;
}

function cellBounds(x: number, y: number, size: number, view: MapBounds): MapBounds {
  const [west, south] = unproject(x - size / 2, y - size / 2);
  const [east, north] = unproject(x + size / 2, y + size / 2);
  return [Math.max(west, view[0]), Math.max(south, view[1]), Math.min(east, view[2]), Math.min(north, view[3])];
}

export async function queryMap(client: Pick<PoolClient, "query">, query: MapQuery): Promise<MapResponse> {
  const { filters, bounds, queryBounds, zoom } = query;
  const result: MapResponse = {
    mode: "grid", features: [], visibleRequests: 0,
    cellSizeMeters: queryBounds ? gridCellSize(queryBounds, zoom) : null,
    bounds, zoom, filters,
    meta: { queryBounds, studyBounds: MAP_STUDY_BOUNDS, generatedAt: new Date().toISOString(), maxGridFeatures: MAX_GRID_FEATURES, maxPointFeatures: MAX_POINT_FEATURES },
  };
  if (!queryBounds) return result;
  const where = buildPredicate(filters);
  const first = where.values.length + 1;
  const envelope = `ST_MakeEnvelope($${first},$${first + 1},$${first + 2},$${first + 3},4326)`;
  const values = [...where.values, ...queryBounds];
  // GiST boxes can have float32 false positives. Geometry is constrained to Point,
  // so these double-coordinate checks give exact inclusive rectangle membership.
  const predicate = `${where.sql} AND geom IS NOT NULL AND geom && ${envelope}
    AND ST_X(geom) >= $${first} AND ST_X(geom) <= $${first + 2}
    AND ST_Y(geom) >= $${first + 1} AND ST_Y(geom) <= $${first + 3}`;
  if (zoom >= 15) {
    // Probe only 101 matches before sorting; a dense viewport discards this sample.
    const points = await client.query<ServiceRequest & { longitude: number; latitude: number }>(`
      SELECT id,to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt",
             to_char(closed_at,'YYYY-MM-DD"T"HH24:MI:SS.US') AS "closedAt",
             status,agency,problem,detail,borough,quality_flags AS "qualityFlags",
             ST_X(geom) AS longitude,ST_Y(geom) AS latitude
      FROM (
        SELECT id,created_at,closed_at,status,agency,problem,detail,borough,quality_flags,geom
        FROM service_requests WHERE ${predicate} LIMIT ${MAX_POINT_FEATURES + 1}
      ) candidates
      ORDER BY created_at DESC,id DESC`, values);
    if (points.rows.length <= MAX_POINT_FEATURES) {
      return { ...result, mode: "points", cellSizeMeters: null, visibleRequests: points.rows.length,
        features: points.rows.map(({ longitude, latitude, ...request }) => ({
          id: `request:${request.id}`, longitude, latitude, count: 1,
          bounds: [longitude, latitude, longitude, latitude], request,
        })),
      };
    }
  }
  const size = result.cellSizeMeters!;
  const groups = await client.query<{ x: number; y: number; longitude: number; latitude: number; count: number }>(`
    SELECT x,y,avg(longitude) AS longitude,avg(latitude) AS latitude,count(*)::int AS count
    FROM (
      SELECT floor(${EARTH_RADIUS} * radians(ST_X(geom)) / $${values.length + 1})::int AS x,
             floor(${EARTH_RADIUS} * ln(tan(pi()/4 + radians(ST_Y(geom))/2)) / $${values.length + 1})::int AS y,
             ST_X(geom) AS longitude,ST_Y(geom) AS latitude
      FROM service_requests WHERE ${predicate}
    ) cells GROUP BY x,y ORDER BY x,y`, [...values, size]);
  const features: MapFeature[] = groups.rows.map((cell) => ({
    id: `cell:${size}:${cell.x}:${cell.y}`,
    // Floating-point AVG can stray by a few ulps at an exact viewport boundary.
    longitude: Math.min(queryBounds[2], Math.max(queryBounds[0], cell.longitude)),
    latitude: Math.min(queryBounds[3], Math.max(queryBounds[1], cell.latitude)),
    count: cell.count, bounds: cellBounds((cell.x + 0.5) * size, (cell.y + 0.5) * size, size, queryBounds),
  }));
  if (features.length > MAX_GRID_FEATURES) throw new Error("Map grid feature bound exceeded");
  return { ...result, features, visibleRequests: features.reduce((sum, feature) => sum + feature.count, 0) };
}

export function readMap(query: MapQuery): Promise<MapResponse> {
  return withReadSnapshot(async (client) => {
    // Measured LLVM compilation dominates this one-off local aggregation.
    await client.query("SET LOCAL jit = off");
    return queryMap(client, query);
  });
}
