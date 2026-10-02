"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Layers3, List, LocateFixed, MapPin, Minus, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import type { GeoJsonObject } from "geojson";
import type * as Leaflet from "leaflet";
import { MAP_STUDY_BOUNDS, type MapBounds, type MapFeature, type MapResponse } from "@/lib/map-types";
import "leaflet/dist/leaflet.css";
import "./request-map.css";

type Filters = { from: string; to: string; problem: string };
type Viewport = { bounds: MapBounds; zoom: number };
const CITY_BOUNDS: MapBounds = [-74.27, 40.49, -73.69, 40.93];
const count = new Intl.NumberFormat("en-US");
const shortCount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const BOUNDARY_SOURCE = "https://www.nyc.gov/content/planning/pages/resources/datasets/borough-boundaries";
const STREET_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

function leafletBounds(bounds: MapBounds): Leaflet.LatLngBoundsLiteral {
  return [[bounds[1], bounds[0]], [bounds[3], bounds[2]]];
}

function sourceDate(value: string | null) {
  return value ? value.replace("T", " · ").replace(/\.\d+$/, "") : "Not provided";
}

async function geography(url: string, signal: AbortSignal): Promise<GeoJsonObject> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("The local borough geography could not load.");
  const result = await response.json();
  if (result.type !== "FeatureCollection" || !Array.isArray(result.features)) throw new Error("The local borough geography is not valid GeoJSON.");
  return result as GeoJsonObject;
}

export default function RequestMap({ filters, missingCoordinates }: { filters: Filters; missingCoordinates: number | null }) {
  const sectionRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const libraryRef = useRef<typeof Leaflet | null>(null);
  const requestsLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const generationRef = useRef(0);
  const hasDispatchedRequestRef = useRef(false);
  const [geographyState, setGeographyState] = useState<{ attempt: number; error: string | null } | null>(null);
  const [geographyRetry, setGeographyRetry] = useState(0);
  const [basemapRetry, setBasemapRetry] = useState(0);
  const [basemap, setBasemap] = useState<{ attempt: number; status: "ready" | "unavailable" } | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [moving, setMoving] = useState(false);
  const [neighborhoodLabels, setNeighborhoodLabels] = useState<"pending" | "ready" | "unavailable">("pending");
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; data: MapResponse | null; error: string | null } | null>(null);
  const [selection, setSelection] = useState<{ key: string; feature: MapFeature } | null>(null);
  const queryKey = JSON.stringify([filters.from, filters.to, filters.problem, viewport, retry]);
  const geographyReady = geographyState?.attempt === geographyRetry && !geographyState.error;
  const geographyError = geographyState?.attempt === geographyRetry ? geographyState.error : null;
  const basemapStatus = geographyReady && basemap?.attempt === basemapRetry ? basemap.status : "loading";
  const current = !moving && result?.key === queryKey ? result : null;
  const data = current?.data ?? null;
  const loading = !current || moving;
  const selected = data && selection?.key === queryKey ? selection.feature : null;
  const zoom = viewport?.zoom ?? 9;

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNearby(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearby) return;
    const abort = new AbortController();
    let disposed = false;
    let localMap: Leaflet.Map | null = null;
    let resize: ResizeObserver | null = null;
    async function initialize() {
      try {
        const [L, boroughs, labels] = await Promise.all([
          import("leaflet"),
          geography("/map/boroughs.geojson", abort.signal),
          geography("/map/labels.geojson", abort.signal),
        ]);
        if (disposed || !containerRef.current) return;
        libraryRef.current = L;
        const map = L.map(containerRef.current, {
          zoomControl: false, attributionControl: false,
          minZoom: 9, maxZoom: 18, zoomSnap: 0.5,
          scrollWheelZoom: false, keyboard: true, keyboardPanDelta: 90,
          maxBounds: leafletBounds(MAP_STUDY_BOUNDS), maxBoundsViscosity: 1,
          preferCanvas: false,
        });
        localMap = map;
        mapRef.current = map;
        map.createPane("localGeography").style.zIndex = "200";
        map.createPane("streets").style.zIndex = "250";
        map.getPane("streets")!.style.pointerEvents = "none";
        map.createPane("requests").style.zIndex = "450";
        map.createPane("placeLabels").style.zIndex = "475";
        map.getPane("placeLabels")!.style.pointerEvents = "none";
        L.geoJSON(boroughs, { pane: "localGeography", interactive: false, style: { color: "#b6c3ae", weight: 1.15, fillColor: "#e9eddf", fillOpacity: 1 } }).addTo(map);
        L.geoJSON(labels, {
          interactive: false,
          pointToLayer(feature, latlng) {
            const label = document.createElement("span");
            label.className = "map-borough-label";
            label.textContent = String(feature.properties?.name ?? "");
            return L.marker(latlng, { pane: "placeLabels", interactive: false, keyboard: false, icon: L.divIcon({ className: "map-place-icon", html: label, iconSize: [130, 20], iconAnchor: [65, 10] }) });
          },
        }).addTo(map);
        requestsLayerRef.current = L.layerGroup().addTo(map);
        const updateViewport = () => {
          const bounds = map.getBounds();
          setViewport({ bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((value) => Number(value.toFixed(6))) as MapBounds, zoom: map.getZoom() });
          setMoving(false);
        };
        map.on("movestart", () => { setMoving(true); requestsLayerRef.current?.clearLayers(); });
        map.on("moveend", updateViewport);
        map.fitBounds(leafletBounds(CITY_BOUNDS), { padding: [20, 20], animate: false });
        updateViewport();
        map.createPane("neighborhoodLabels").style.zIndex = "425";
        map.getPane("neighborhoodLabels")!.style.pointerEvents = "none";
        // Keep local place labels available when the street basemap cannot load.
        void geography("/map/neighborhood-labels.geojson", abort.signal).then((places) => {
          if (disposed) return;
          const labels: { marker: Leaflet.Marker; width: number }[] = [];
          L.geoJSON(places, { pointToLayer(feature, latlng) {
            const name = String(feature.properties?.name ?? "");
            const label = document.createElement("span");
            label.className = "map-neighborhood-label";
            label.textContent = name;
            const width = Math.min(220, Math.max(85, name.length * 5.5));
            const marker = L.marker(latlng, { pane: "neighborhoodLabels", interactive: false, keyboard: false, icon: L.divIcon({ className: "map-place-icon", html: label, iconSize: [width, 28], iconAnchor: [width / 2, 14] }) });
            labels.push({ marker, width });
            return marker;
          } });
          const layer = L.layerGroup().addTo(map);
          const renderLabels = () => {
            layer.clearLayers();
            if (map.getZoom() < 14) return;
            const occupied: { x: number; y: number; width: number }[] = [];
            for (const item of labels) {
              if (!map.getBounds().contains(item.marker.getLatLng())) continue;
              const { x, y } = map.latLngToContainerPoint(item.marker.getLatLng());
              if (occupied.some((other) => Math.abs(x - other.x) < (item.width + other.width) / 2 + 8 && Math.abs(y - other.y) < 36)) continue;
              occupied.push({ x, y, width: item.width });
              item.marker.addTo(layer);
            }
          };
          map.on("moveend", renderLabels);
          renderLabels();
          setNeighborhoodLabels("ready");
        }).catch(() => { if (!disposed && !abort.signal.aborted) setNeighborhoodLabels("unavailable"); });
        resize = new ResizeObserver(() => map.invalidateSize({ pan: false }));
        resize.observe(containerRef.current);
        setGeographyState({ attempt: geographyRetry, error: null });
      } catch (reason) {
        if (!disposed && !abort.signal.aborted) setGeographyState({ attempt: geographyRetry, error: reason instanceof Error ? reason.message : "The local map could not start." });
      }
    }
    void initialize();
    return () => {
      disposed = true;
      abort.abort();
      resize?.disconnect();
      localMap?.remove();
      mapRef.current = null;
      requestsLayerRef.current = null;
    };
  }, [geographyRetry, nearby]);

  useEffect(() => {
    const map = mapRef.current;
    const L = libraryRef.current;
    if (!geographyReady || !map || !L) return;
    let stopped = false;
    let timeout: number | undefined;
    const tiles = L.tileLayer(STREET_TILES, {
      pane: "streets", minZoom: 9, maxZoom: 18,
      noWrap: true,
      updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 1,
      referrerPolicy: "strict-origin-when-cross-origin",
    });
    const fallBack = () => {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(timeout);
      // Leaflet's remove event must detach its map listeners before off().
      tiles.remove();
      tiles.off();
      setBasemap({ attempt: basemapRetry, status: "unavailable" });
    };
    // Basemap loading never gates the local geography or service-request query.
    tiles.on("loading", () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(fallBack, 12_000);
    });
    tiles.on("tileerror", fallBack);
    tiles.on("load", () => {
      if (stopped) return;
      window.clearTimeout(timeout);
      setBasemap({ attempt: basemapRetry, status: "ready" });
    });
    tiles.addTo(map);
    return () => {
      stopped = true;
      window.clearTimeout(timeout);
      if (map.hasLayer(tiles)) map.removeLayer(tiles);
      tiles.off();
    };
  }, [basemapRetry, geographyReady]);

  useEffect(() => {
    if (!viewport || !geographyReady || moving) return;
    const generation = ++generationRef.current;
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const [west, south, east, north] = viewport.bounds;
        const query = new URLSearchParams({ from: filters.from, to: filters.to, west: String(west), south: String(south), east: String(east), north: String(north), zoom: String(viewport.zoom) });
        if (filters.problem) query.set("problem", filters.problem);
        hasDispatchedRequestRef.current = true;
        const response = await fetch(`/api/map?${query}`, { signal: abort.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message ?? "Map requests could not load.");
        if (!abort.signal.aborted && generation === generationRef.current) setResult({ key: queryKey, data: payload as MapResponse, error: null });
      } catch (reason) {
        if (!abort.signal.aborted && generation === generationRef.current) setResult({ key: queryKey, data: null, error: reason instanceof Error ? reason.message : "Map requests could not load." });
      }
    }, hasDispatchedRequestRef.current ? 250 : 0);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [filters.from, filters.to, filters.problem, viewport, queryKey, geographyReady, moving]);

  const closeDetails = useCallback(() => {
    setSelection(null);
    const previous = returnFocusRef.current;
    if (previous?.isConnected) previous.focus();
    else containerRef.current?.focus();
  }, []);

  const openFeature = useCallback((feature: MapFeature) => {
    const map = mapRef.current;
    const L = libraryRef.current;
    if (!map || !L) return;
    if (!feature.request && map.getZoom() < 18) {
      const bounds = L.latLngBounds(leafletBounds(feature.bounds));
      const nextZoom = Math.min(18, Math.max(map.getZoom() + 1, Math.min(map.getZoom() + 2, map.getBoundsZoom(bounds, false, L.point(32, 32)))));
      map.setView(bounds.getCenter(), nextZoom, { animate: false });
      return;
    }
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelection({ key: queryKey, feature });
  }, [queryKey]);

  useEffect(() => {
    const L = libraryRef.current;
    const layer = requestsLayerRef.current;
    if (!L || !layer) return;
    layer.clearLayers();
    if (!data) return;
    for (const feature of data.features) {
      const point = Boolean(feature.request);
      const size = point ? 18 : Math.min(46, Math.max(28, 22 + Math.log10(Math.max(1, feature.count)) * 6));
      const content = document.createElement("span");
      content.className = point ? "map-point-core" : "map-cluster-count";
      content.textContent = point ? "" : shortCount.format(feature.count);
      const title = point ? `Request ${feature.request!.id}: ${feature.request!.problem}. Open details.` : `${count.format(feature.count)} requests in this grid cell. ${zoom >= 18 ? "Open area details." : "Zoom into area."}`;
      const marker = L.marker([feature.latitude, feature.longitude], {
        pane: "requests", keyboard: true, title,
        icon: L.divIcon({ className: point ? "map-request-point" : "map-request-cluster", html: content, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      }).addTo(layer);
      marker.on("click", () => openFeature(feature));
      const element = marker.getElement();
      if (element) {
        element.setAttribute("aria-label", title);
        // The native list supplies every feature without hundreds of sequential map Tab stops.
        element.tabIndex = -1;
        element.addEventListener("keydown", (event) => { if (event.key === " ") { event.preventDefault(); openFeature(feature); } });
      }
    }
    return () => { layer.clearLayers(); };
  }, [data, openFeature, zoom]);

  useEffect(() => {
    if (!selected) return;
    detailRef.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeDetails(); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [selected, closeDetails]);

  return (
    <section ref={sectionRef} id="map" className="panel request-map-panel" aria-labelledby="map-title">
      <div className="panel-heading map-panel-heading"><div><div className="eyebrow">THE GEOGRAPHY OF A REQUEST</div><h2 id="map-title">See the city in context</h2></div><span className="map-mode"><Layers3 size={14} /> {data?.mode === "points" ? "Individual requests" : "Requests by area"}</span></div>
      <div className="map-summary-strip"><div><strong data-testid="map-visible-count">{data ? count.format(data.visibleRequests) : "—"}</strong><span>requests in this map view</span></div><span className="map-filter-note">Same problem and date filters. Pan and zoom to explore.</span></div>
      <div className={`map-canvas-frame${loading ? " map-stale" : ""}${basemapStatus === "ready" ? " map-streets-ready" : ""}`}>
        <div ref={containerRef} className="request-map-canvas" tabIndex={0} role="region" aria-label="NYC service request map. Use arrow keys to pan, plus and minus to zoom." aria-describedby="map-instructions" />
        {geographyReady && <><div className="map-north" aria-hidden="true"><span>N</span><i /></div><div className="map-controls" role="group" aria-label="Map controls"><button type="button" aria-label="Zoom in" disabled={zoom >= 18} onClick={() => mapRef.current?.zoomIn()}><Plus size={18} /></button><button type="button" aria-label="Zoom out" disabled={zoom <= 9} onClick={() => mapRef.current?.zoomOut()}><Minus size={18} /></button><button type="button" className="map-reset" aria-label="Reset map to all boroughs" onClick={() => mapRef.current?.fitBounds(leafletBounds(CITY_BOUNDS), { padding: [20, 20], animate: false })}><LocateFixed size={18} /></button></div><span className="map-zoom-label">ZOOM {zoom.toFixed(zoom % 1 ? 1 : 0)}</span></>}
        {!geographyReady && !geographyError && <div className="map-state-overlay"><RefreshCw size={23} className="map-spinning" /><strong>Drawing the five boroughs</strong><span>Loading local NYC geography.</span></div>}
        {geographyError && <div className="map-state-overlay map-geography-error" role="alert"><TriangleAlert size={24} /><strong>The borough map couldn’t load.</strong><span>{geographyError}</span><button type="button" onClick={() => setGeographyRetry((attempt) => attempt + 1)}><RefreshCw size={14} /> Retry geography</button></div>}
        {geographyReady && loading && <div className="map-loading-pill" role="status"><RefreshCw size={13} className="map-spinning" /> {moving ? "Move the map to explore" : "Loading this area…"}</div>}
        {geographyReady && current?.error && <div className="map-state-overlay map-data-error" role="alert"><TriangleAlert size={23} /><strong>This area couldn’t load.</strong><span>{current.error}</span><button type="button" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} /> Retry map data</button></div>}
        {geographyReady && data?.visibleRequests === 0 && <div className="map-empty-note" role="status"><MapPin size={18} /><div><strong>No requests in this area</strong><span>Pan, reset the map, or change the filters.</span></div></div>}
        {selected && <aside ref={detailRef} className="map-request-detail" role="dialog" aria-modal="false" aria-labelledby="map-detail-title" tabIndex={-1}><button type="button" className="map-detail-close" onClick={closeDetails} aria-label="Close request details"><X size={17} /></button><div className="eyebrow">{selected.request ? "ONE REQUEST, IN CONTEXT" : "A DENSE AREA"}</div><h3 id="map-detail-title">{selected.request?.problem ?? `${count.format(selected.count)} requests in this cell`}</h3>{selected.request ? <><p>{selected.request.detail || "No problem detail provided."}</p><dl><div><dt>Request ID</dt><dd>{selected.request.id}</dd></div><div><dt>Status</dt><dd>{selected.request.status}</dd></div><div><dt>Agency / borough</dt><dd>{selected.request.agency} / {selected.request.borough || "Unspecified"}</dd></div><div><dt>Created</dt><dd>{sourceDate(selected.request.createdAt)}</dd></div><div><dt>Closed</dt><dd>{sourceDate(selected.request.closedAt)}</dd></div></dl>{selected.request.qualityFlags.length > 0 && <p className="map-quality-flags">Data flags: {selected.request.qualityFlags.join(", ")}</p>}<span className="map-time-note">Source timestamps; publisher-local time assumed.</span></> : <p>This area still contains more requests than the individual-point limit. Narrow the problem or date filters to explore individual requests.</p>}</aside>}
        <div className="map-legend"><span className="map-legend-dot" /><span>{data?.mode === "points" ? "One marker = one request" : "Circles show grouped request counts"}</span></div>
        <div className="map-tile-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors</div>
      </div>
      <div className="map-status-line" aria-live="polite"><span>{data ? data.mode === "points" ? `${count.format(data.features.length)} individual requests shown` : `${count.format(data.features.length)} grid cells shown · ${zoom >= 18 ? "Narrow filters to see individual requests in dense areas." : "Select a circle to zoom in."}` : current?.error ? "Map data unavailable" : "Waiting for the current map view"}</span><span>{missingCoordinates === null ? "Updating coordinate coverage…" : `${count.format(missingCoordinates)} without coordinates · retained in totals and table`}</span></div>
      <div className="map-explanation"><p id="map-instructions">Arrow keys pan the focused map; + / − zoom. Page scrolling stays enabled. Grouped circles use average request coordinates within each cell, not a specific address. The chart and table keep the full filtered cohort.{data?.mode === "points" && " Some requests share a location; the list includes each request."}</p><a href={BOUNDARY_SOURCE} target="_blank" rel="noreferrer">Borough geography: NYC Department of City Planning <ArrowUpRight size={12} /></a></div>
      <details className="map-accessible-list"><summary><List size={15} /><span>Explore this map as a list</span><span className="map-list-count">{data ? `${data.features.length} ${data.mode === "points" ? "requests" : "areas"}` : "Updating"}</span><ChevronDown size={15} /></summary>{data ? data.features.length ? <ol>{data.features.map((feature, index) => <li key={feature.id}><button type="button" onClick={() => openFeature(feature)}><span><strong>{feature.request ? `${feature.request.problem} · ${feature.request.id}` : `Area ${index + 1} · ${count.format(feature.count)} requests`}</strong><small>{feature.latitude.toFixed(4)}, {feature.longitude.toFixed(4)}{feature.request ? ` · ${feature.request.status}` : " · group center"}</small></span><span>{feature.request || zoom >= 18 ? "Details" : "Zoom in"}<ArrowUpRight size={13} /></span></button></li>)}</ol> : <p>No matching requests in this map view.</p> : <p>{current?.error ? "Retry the map data to load the accessible list." : "The list updates with the map."}</p>}</details>
      <div className="map-attribution"><div className="map-basemap-status"><span aria-live="polite">{basemapStatus === "ready" ? "Street map · Zoom in for street names and building footprints." : basemapStatus === "unavailable" ? "Street map unavailable · Showing local borough geography." : "Loading street map · Local borough geography available."}{basemapStatus === "unavailable" && neighborhoodLabels === "ready" ? " Close-up names are NYC DCP statistical areas." : ""}</span>{basemapStatus === "unavailable" && <button type="button" onClick={() => setBasemapRetry((attempt) => attempt + 1)}><RefreshCw size={13} /> Retry street map</button>}</div><a href="https://leafletjs.com" target="_blank" rel="noreferrer">Leaflet</a></div>
    </section>
  );
}
