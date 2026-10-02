import { COHORT } from "./types";
import { MAP_STUDY_BOUNDS, type MapBounds } from "./map-types";

export type DashboardFilters = { from: string; to: string; problem: string };
export type Camera = { latitude: number; longitude: number; zoom: number };
export type PageAnchor = { cursor: string | null; direction: "next" | "previous"; page: number };
export type ExplorerState = PageAnchor & { filters: DashboardFilters; area: MapBounds | null; camera: Camera | null; request: string | null; mode: "pages" | "continuous" };
export const FIRST_PAGE: PageAnchor = { cursor: null, direction: "next", page: 1 };
export const DEFAULT_FILTERS: DashboardFilters = { ...COHORT, problem: "" };

export function parseExplorerState(params: URLSearchParams): ExplorerState {
  const date = (key: string, fallback: string) => /^2026-08-(0[1-9]|[12]\d|3[01])$/.test(params.get(key) ?? "") ? params.get(key)! : fallback;
  let from = date("from", COHORT.from);
  const to = date("to", COHORT.to);
  if (from > to) from = COHORT.from;
  const problem = params.get("problem") ?? "";
  const numbers = (key: string, length: number) => {
    const raw = params.get(key)?.split(",");
    return raw?.length === length && raw.every((n) => n.trim() && Number.isFinite(Number(n))) ? raw.map(Number) : null;
  };
  const box = numbers("area", 4);
  const area = box && box[0] >= -180 && box[2] <= 180 && box[0] < box[2] && box[1] >= -85 && box[3] <= 85 && box[1] < box[3] ? box as MapBounds : null;
  const view = numbers("view", 3);
  const camera = view && view[0] >= MAP_STUDY_BOUNDS[1] && view[0] <= MAP_STUDY_BOUNDS[3] && view[1] >= MAP_STUDY_BOUNDS[0] && view[1] <= MAP_STUDY_BOUNDS[2] && view[2] >= 9 && view[2] <= 18 ? { latitude: view[0], longitude: view[1], zoom: view[2] } : null;
  const rawCursor = params.get("after") ?? params.get("before");
  const cursor = rawCursor && /^[A-Za-z0-9_-]{1,2048}$/.test(rawCursor) && !(params.has("after") && params.has("before")) ? rawCursor : null;
  const page = Number(params.get("page"));
  const request = params.get("request");
  return {
    filters: { from, to, problem: problem.length <= 250 && !/[\u0000-\u001f]/.test(problem) ? problem : "" },
    area, camera, request: request && request.trim() && request.length <= 100 && !/[\u0000-\u001f]/.test(request) ? request : null,
    cursor, direction: cursor && params.has("before") ? "previous" : "next", page: cursor && Number.isInteger(page) && page >= 1 && page <= 1_000_000 ? page : 1,
    mode: params.get("mode") === "continuous" ? "continuous" : "pages",
  };
}

export function explorerParams(state: ExplorerState): URLSearchParams {
  const params = new URLSearchParams({ from: state.filters.from, to: state.filters.to });
  if (state.filters.problem) params.set("problem", state.filters.problem);
  if (state.area) params.set("area", state.area.join(","));
  if (state.camera) params.set("view", [state.camera.latitude, state.camera.longitude, state.camera.zoom].join(","));
  if (state.request) params.set("request", state.request);
  if (state.cursor) { params.set(state.direction === "previous" ? "before" : "after", state.cursor); params.set("page", String(state.page)); }
  if (state.mode === "continuous") params.set("mode", "continuous");
  return params;
}

export function requestParams(filters: DashboardFilters, area: MapBounds | null, anchor: PageAnchor): URLSearchParams {
  const params = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.problem) params.set("problem", filters.problem);
  if (area) ["west", "south", "east", "north"].forEach((key, index) => params.set(key, String(area[index])));
  if (anchor.cursor) { params.set("cursor", anchor.cursor); params.set("direction", anchor.direction); }
  return params;
}
