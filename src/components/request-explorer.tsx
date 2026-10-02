"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ChevronLeft, ChevronRight, ListFilter, RefreshCw, TriangleAlert } from "lucide-react";
import type { PulseResponse, ServiceRequest } from "@/lib/types";
import type { MapBounds } from "@/lib/map-types";
import { MAX_CACHED_PAGES, type RequestPage } from "@/lib/request-types";
import { FIRST_PAGE, requestParams, type DashboardFilters, type PageAnchor } from "@/lib/explorer-state";
import "./request-explorer.css";

const number = new Intl.NumberFormat("en-US");
const ROW_HEIGHT = 80;
const PAGE_CACHE_MS = 60_000;
type Entry = { key: string; anchor: PageAnchor; data: RequestPage; fetchedAt: number };
type Props = {
  filters: DashboardFilters; area: MapBounds | null; seed: PulseResponse; anchor: PageAnchor;
  mode: "pages" | "continuous"; selectedId: string | null;
  onNavigate: (anchor: PageAnchor, replace?: boolean) => void;
  onModeChange: (mode: "pages" | "continuous") => void;
  onSelect: (id: string) => void; onClearArea: () => void;
};

function displayDate(value: string) { return `Aug ${Number(value.slice(8, 10))}`; }
function displayTime(value: string) {
  const match = value.match(/T(\d{2}):(\d{2})/);
  if (!match) return "Time unavailable";
  const hours = Number(match[1]);
  return `${hours % 12 || 12}:${match[2]} ${hours >= 12 ? "PM" : "AM"}`;
}
function titleCase(value: string | null) { return value ? value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unspecified"; }

function RequestRows({ rows, selectedId, onSelect }: { rows: ServiceRequest[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return <>{rows.map((request) => <tr key={request.id} className={selectedId === request.id ? "request-selected" : ""}>
    <td className="created-cell"><strong>{displayDate(request.createdAt)}</strong><span>{displayTime(request.createdAt)}</span></td>
    <td className="problem-cell"><button type="button" className="request-open" aria-label={`Open request ${request.id}: ${request.problem}`} onClick={() => onSelect(request.id)}><strong>{request.problem || "Unspecified"}</strong><span title={request.detail ?? undefined}>{request.detail || "No detail provided"}</span></button></td>
    <td className="borough-cell">{titleCase(request.borough)}</td><td><span className="agency-badge">{request.agency || "—"}</span></td>
    <td><span className={`status-badge ${request.status?.toLowerCase() === "closed" ? "status-closed" : "status-other"}`}><span />{request.status || "Unknown"}</span></td>
    <td className="request-id">{request.id}{Boolean(request.qualityFlags?.length) && <span className="quality-indicator" tabIndex={0} role="img" aria-label={`Data quality flags: ${request.qualityFlags.join(", ")}`} title={`Data quality flags: ${request.qualityFlags.join(", ")}`}><TriangleAlert size={12} /></span>}</td>
  </tr>)}</>;
}

export default function RequestExplorer({ filters, area, seed, anchor, mode, selectedId, onNavigate, onModeChange, onSelect, onClearArea }: Props) {
  const firstKey = requestParams(filters, area, FIRST_PAGE).toString();
  const queryKey = requestParams(filters, area, anchor).toString();
  const [entries, setEntries] = useState<Entry[]>(() => !area && !anchor.cursor ? [{ key: firstKey, anchor: FIRST_PAGE, fetchedAt: Date.now(), data: { requests: seed.requests.map((row) => ({ ...row, latitude: null, longitude: null })), nextCursor: seed.nextCursor, previousCursor: null, filters: seed.meta.filters, bounds: null, generatedAt: seed.meta.generatedAt } }] : []);
  const entriesRef = useRef(entries);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const handledRetry = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const current = entries.find((entry) => entry.key === queryKey);
  const error = failure?.key === queryKey ? failure.message : null;
  const loading = pending === queryKey || (!current && !error);
  const ordered = useMemo(() => [...entries].sort((a, b) => a.anchor.page - b.anchor.page), [entries]);
  const rows = useMemo(() => mode === "continuous" ? ordered.flatMap((entry) => entry.data.requests) : current?.data.requests ?? [], [mode, ordered, current]);
  const focusedIndex = rows.findIndex((row) => row.id === focusedId);
  const virtualizer = useVirtualizer({
    count: mode === "continuous" ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT, overscan: 4,
    getItemKey: (index) => rows[index].id,
    rangeExtractor: useCallback((range) => {
      const indexes = defaultRangeExtractor(range);
      return focusedIndex >= 0 ? [...new Set([...indexes, focusedIndex])].sort((a, b) => a - b) : indexes;
    }, [focusedIndex]),
  });

  const fetchPage = useCallback(async (next: PageAnchor, append: boolean) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const key = requestParams(filters, area, next).toString();
    // Begin after the caller's state transition; never block an input handler.
    await Promise.resolve();
    if (abort.signal.aborted) return;
    setPending(append ? queryKey : key);
    setFailure(null);
    try {
      const response = await fetch(`/api/requests?${key}`, { signal: abort.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "Requests could not load.");
      if (abort.signal.aborted) return;
      const entry = { key, anchor: next, data: payload as RequestPage, fetchedAt: Date.now() };
      const previous = entriesRef.current;
      const keep = mode === "continuous" && !append ? [] : previous.filter((item) => item.anchor.page !== next.page);
      const updated = [...keep, entry].slice(-MAX_CACHED_PAGES);
      const removedAbove = append ? previous.filter((item) => !updated.includes(item) && item.anchor.page < next.page).reduce((sum, item) => sum + item.data.requests.length, 0) : 0;
      const active = document.activeElement;
      if (removedAbove && active instanceof HTMLButtonElement && scrollRef.current?.contains(active) && Number(active.dataset.rowIndex) < removedAbove) {
        scrollRef.current.focus({ preventScroll: true });
        setFocusedId(null);
      }
      entriesRef.current = updated;
      setEntries(updated);
      if (append) onNavigate(next, true);
      if (removedAbove && scrollRef.current) scrollRef.current.scrollTop = Math.max(0, scrollRef.current.scrollTop - removedAbove * ROW_HEIGHT);
    } catch (reason) {
      if (!abort.signal.aborted) setFailure({ key: append ? queryKey : key, message: reason instanceof Error ? reason.message : "Requests could not load." });
    } finally { if (controller.current === abort) setPending(null); }
  }, [filters, area, onNavigate, queryKey, mode]);

  useEffect(() => {
    const entry = entriesRef.current.find((item) => item.key === queryKey);
    const retryRequested = retry !== handledRetry.current;
    handledRetry.current = retry;
    if (!entry || Date.now() - entry.fetchedAt > PAGE_CACHE_MS || retryRequested) void fetchPage(anchor, false);
    return () => { controller.current?.abort(); };
    // A new route anchor or explicit retry owns this request. Appends retain the bounded window.
  }, [queryKey, retry, anchor, fetchPage]);

  // A retained keyboard-focus row may be outside the visible scroll range.
  const lastVirtualIndex = virtualizer.range?.endIndex ?? -1;
  const last = ordered.at(-1);
  useEffect(() => {
    if (mode !== "continuous" || loading || error || !last?.data.nextCursor || lastVirtualIndex < rows.length - 6) return;
    void fetchPage({ cursor: last.data.nextCursor, direction: "next", page: last.anchor.page + 1 }, true);
  }, [mode, loading, error, last, lastVirtualIndex, rows.length, fetchPage]);

  const navigatePage = (direction: "next" | "previous") => {
    if (!current) return;
    const page = anchor.page + (direction === "next" ? 1 : -1);
    const cached = entries.find((entry) => entry.anchor.page === page && Date.now() - entry.fetchedAt <= PAGE_CACHE_MS);
    const cursor = direction === "next" ? current.data.nextCursor : current.data.previousCursor;
    if (cached) onNavigate(cached.anchor);
    else if (cursor) onNavigate({ cursor, direction, page: Math.max(1, page) });
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const switchMode = (next: "pages" | "continuous") => {
    if (current) { entriesRef.current = [current]; setEntries([current]); }
    setFocusedId(null);
    onModeChange(next);
  };
  const focusRow = (index: number) => {
    const target = Math.max(0, Math.min(rows.length - 1, index));
    setFocusedId(rows[target]?.id ?? null);
    virtualizer.scrollToIndex(target, { align: "auto" });
    requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${target}"]`)?.focus());
  };

  return <section id="requests" className="panel requests-panel" aria-labelledby="requests-title" data-cached-pages={entries.length} data-cached-rows={entries.reduce((sum, entry) => sum + entry.data.requests.length, 0)}>
    <div className="panel-heading"><div><div className="eyebrow">BEHIND THE NUMBERS</div><h2 id="requests-title">Explore the requests <span className="count-pill">{area ? "Selected map area" : number.format(seed.summary.total)}</span></h2></div><span className="table-order"><ArrowDown size={13} /> Newest first</span></div>
    <div className="explorer-toolbar"><div role="group" aria-label="Request browsing mode"><button type="button" aria-pressed={mode === "pages"} onClick={() => switchMode("pages")}>Paged table</button><button type="button" aria-pressed={mode === "continuous"} onClick={() => switchMode("continuous")}>Continuous list</button></div><span>{area ? "List limited to your selected map area." : "Select a request to see its location and details."}</span>{area && <button type="button" onClick={onClearArea}>Clear map area</button>}</div>
    {area && <p className="explorer-scope">The chart and summary still describe the full date and problem selection. Panning does not change this list until you select “Search this area”.</p>}
    <div className="explorer-feedback" aria-live="polite">{loading ? <span><RefreshCw size={13} className="map-spinning" /> Loading requests…</span> : error ? <span role="alert">{error} <button type="button" onClick={() => setRetry((n) => n + 1)}>Retry requests</button></span> : <span>{mode === "continuous" ? `${number.format(rows.length)} requests available in this scrolling window` : `${number.format(rows.length)} requests on page ${anchor.page}`}</span>}</div>
    {!loading && !error && !rows.length ? <div className="table-empty"><ListFilter size={28} /><h3>No matching requests</h3><p>Change the filters or clear the map area to explore another part of the month.</p></div> : mode === "pages" ? <div className="table-scroll" tabIndex={0} role="region" aria-label="Service request records. Scroll for more rows." aria-busy={loading} inert={loading}>
      <table><thead><tr><th scope="col">Created <ArrowDown size={11} /></th><th scope="col">Problem / detail</th><th scope="col">Borough</th><th scope="col">Agency</th><th scope="col">Status</th><th scope="col" className="id-heading">Request ID</th></tr></thead><tbody><RequestRows rows={rows} selectedId={selectedId} onSelect={onSelect} /></tbody></table>
    </div> : <>
      <p id="continuous-instructions" className="explorer-scope">Scroll to load more. Arrow keys move between requests; Home and End move within the loaded window. The paged table offers an alternative way to read every record.</p>
      {ordered[0]?.data.previousCursor && <button type="button" className="load-earlier" disabled={loading} onClick={() => {
        const first = ordered[0];
        entriesRef.current = []; setEntries([]); setFocusedId(null);
        onNavigate({ cursor: first.data.previousCursor, direction: "previous", page: Math.max(1, first.anchor.page - 1) }, true);
        scrollRef.current?.scrollTo({ top: 0 });
      }}>Load earlier requests</button>}
      <div ref={scrollRef} className="request-virtual-scroll" role="region" aria-label="Continuous service requests" aria-describedby="continuous-instructions" tabIndex={0}>
        <ol className="request-virtual-list" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return <li key={row.id} aria-posinset={(ordered[0]?.anchor.page - 1 || 0) * 50 + item.index + 1} aria-setsize={-1} style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}>
              <button type="button" data-row-index={item.index} aria-label={`Open request ${row.id}: ${row.problem}`} aria-pressed={row.id === selectedId} onFocus={() => setFocusedId(row.id)} onBlur={() => setFocusedId(null)} onClick={() => onSelect(row.id)} onKeyDown={(event) => {
                const target = event.key === "ArrowDown" ? item.index + 1 : event.key === "ArrowUp" ? item.index - 1 : event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : null;
                if (target !== null) { event.preventDefault(); focusRow(target); }
              }}><span><strong>{row.problem}</strong><small>{row.detail || "No detail provided"}</small></span><span><b>{displayDate(row.createdAt)} · {row.agency}</b><small>{row.id} · {row.status}</small></span></button>
            </li>;
          })}
        </ol>
      </div>
      {!last?.data.nextCursor && rows.length > 0 && <p className="explorer-scope">You’ve reached the end of this selection.</p>}
    </>}
    {mode === "pages" && <div className="table-pagination"><span><b>{rows.length}</b> requests on page <b>{anchor.page}</b>{!area && <span className="pagination-detail"> · {number.format(seed.summary.total)} matching</span>}</span><div><button type="button" onClick={() => navigatePage("previous")} disabled={loading || (!current?.data.previousCursor && !entries.some((entry) => entry.anchor.page === anchor.page - 1))} aria-label="Previous page"><ChevronLeft size={15} /> Previous</button><button type="button" onClick={() => navigatePage("next")} disabled={loading || !current?.data.nextCursor} aria-label="Next page">Next <ChevronRight size={15} /></button></div></div>}
  </section>;
}
