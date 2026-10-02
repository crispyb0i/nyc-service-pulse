import type { Filters, ServiceRequest } from "./types";
import type { MapBounds } from "./map-types";

export type LocatedRequest = ServiceRequest & { latitude: number | null; longitude: number | null };
export type RequestPage = {
  requests: LocatedRequest[];
  nextCursor: string | null;
  previousCursor: string | null;
  filters: Filters;
  bounds: MapBounds | null;
  generatedAt: string;
};
export const MAX_CACHED_PAGES = 8;
