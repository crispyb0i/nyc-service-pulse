import type { Filters, ServiceRequest } from "./types";

export type MapBounds = [west: number, south: number, east: number, north: number];
export const MAP_STUDY_BOUNDS: MapBounds = [-74.6, 40.3, -73.4, 41.15];
export const MAX_GRID_FEATURES = 400;
export const MAX_POINT_FEATURES = 100;
export type MapFeature = {
  id: string;
  longitude: number;
  latitude: number;
  count: number;
  bounds: MapBounds;
  request?: ServiceRequest;
};
export type MapResponse = {
  mode: "grid" | "points";
  features: MapFeature[];
  visibleRequests: number;
  cellSizeMeters: number | null;
  bounds: MapBounds;
  zoom: number;
  filters: Filters;
  meta: {
    queryBounds: MapBounds | null;
    studyBounds: MapBounds;
    generatedAt: string;
    maxGridFeatures: number;
    maxPointFeatures: number;
  };
};
