"use client";

import { useCallback, useEffect, useState } from "react";
import type { PulseResponse, ProblemsResponse } from "@/lib/types";
import RequestMap from "@/components/request-map";
import {
  ArrowDown,
  ArrowDownRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  ExternalLink,
  Filter,
  ListFilter,
  MapPinOff,
  Map,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";

type Filters = { from: string; to: string; problem: string };
type DailyCount = { date: string; count: number };
type PulseData = PulseResponse;
type Problem = { name: string; count: number };

const INITIAL_FILTERS: Filters = { from: "2026-08-01", to: "2026-08-31", problem: "" };
const number = new Intl.NumberFormat("en-US");
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const SOURCE_URL = "https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2020-to-Present/erm2-nwe9";

function displayDate(value: string, withYear = false) {
  const date = value.slice(0, 10);
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(month) - 1] ?? month} ${Number(day)}${withYear ? `, ${year}` : ""}`;
}

function displayTime(value: string) {
  const match = value.match(/T(\d{2}):(\d{2})/);
  if (!match) return "Time unavailable";
  const hours = Number(match[1]);
  return `${hours % 12 || 12}:${match[2]} ${hours >= 12 ? "PM" : "AM"}`;
}

function titleCase(value: string | null) {
  if (!value || value.toUpperCase() === "UNSPECIFIED") return "Unspecified";
  return value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function humanDuration(hours: number | null) {
  if (hours === null || !Number.isFinite(hours)) return { value: "—", unit: "" };
  if (hours < 48) return { value: hours.toFixed(1), unit: "hrs" };
  return { value: (hours / 24).toFixed(1), unit: "days" };
}

type InitialQuery = Record<string, string | string[] | undefined>;

function filtersFromQuery(query: InitialQuery): Filters {
  const validDate = (value: unknown): value is string => typeof value === "string" && /^2026-08-(0[1-9]|[12]\d|3[01])$/.test(value);
  const from = validDate(query.from) ? query.from : INITIAL_FILTERS.from;
  const to = validDate(query.to) ? query.to : INITIAL_FILTERS.to;
  return { from: from <= to ? from : INITIAL_FILTERS.from, to, problem: typeof query.problem === "string" ? query.problem : "" };
}

function readUrlFilters(): Filters {
  return filtersFromQuery(Object.fromEntries(new URLSearchParams(window.location.search)));
}

function PulseMark({ small = false }: { small?: boolean }) {
  return <span aria-hidden="true" className={`pulse-mark${small ? " pulse-mark-small" : ""}`}><i /><i /><i /><i /></span>;
}

function MetricSkeleton() {
  return <div className="metric-grid" aria-label="Loading summary"><div className="metric-card skeleton-card"><span /><b /><i /></div><div className="metric-card skeleton-card"><span /><b /><i /></div><div className="metric-card skeleton-card"><span /><b /><i /></div><div className="metric-card skeleton-card"><span /><b /><i /></div></div>;
}

function DailyChart({ daily, total }: { daily: DailyCount[]; total: number }) {
  const [active, setActive] = useState<DailyCount | null>(null);
  const highest = Math.max(0, ...daily.map((day) => day.count));
  const ceiling = highest === 0 ? 100 : Math.ceil(highest / (highest > 10000 ? 5000 : highest > 1000 ? 1000 : highest > 100 ? 100 : 10)) * (highest > 10000 ? 5000 : highest > 1000 ? 1000 : highest > 100 ? 100 : 10);
  const peak = daily.reduce<DailyCount | null>((best, day) => !best || day.count > best.count ? day : best, null);
  const average = daily.length ? Math.round(total / daily.length) : 0;
  const selectedDay = active ? daily.find((day) => day.date === active.date) ?? null : null;
  return (
    <section className="panel chart-panel" aria-labelledby="activity-title">
      <div className="panel-heading">
        <div><div className="eyebrow">THE DAILY PICTURE</div><h2 id="activity-title">Service requests over time</h2></div>
        <div className="chart-key"><span /> Requests created</div>
      </div>
      <div className="chart-summary">
        <div><strong>{number.format(selectedDay ? selectedDay.count : average)}</strong><span>{selectedDay ? `requests on ${displayDate(selectedDay.date)}` : "requests per day, on average"}</span></div>
        {peak && peak.count > 0 && <span className="peak-note"><ArrowUpRight size={15} /> Peak: {displayDate(peak.date)} <b>{number.format(peak.count)}</b></span>}
      </div>
      <div className="chart" role="group" aria-label="Daily request counts" aria-describedby="chart-description">
        <div className="chart-axis" aria-hidden="true">{[ceiling, ceiling * 0.75, ceiling * 0.5, ceiling * 0.25, 0].map((tick, index) => <span key={index}>{compactNumber.format(tick)}</span>)}</div>
        <div className="chart-plot">
          <div className="chart-grid" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <div className="chart-bars">
            {daily.map((day, index) => (
              <div className="chart-column" key={day.date}>
                <button
                  type="button"
                  className={`chart-bar${selectedDay?.date === day.date ? " selected" : ""}${day.count === 0 ? " zero" : ""}`}
                  style={{ height: `${Math.max(day.count ? 0.9 : 0, day.count / ceiling * 100)}%` }}
                  aria-label={`${displayDate(day.date, true)}: ${number.format(day.count)} requests`}
                  onMouseEnter={() => setActive(day)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(day)}
                  onBlur={() => setActive(null)}
                  onClick={() => setActive(day)}
                >
                  <span className="chart-tooltip" aria-hidden="true"><b>{number.format(day.count)}</b>{displayDate(day.date)}</span>
                </button>
                <span className={`chart-day${index === 0 || index === daily.length - 1 || ((index + 1) % 5 === 0 && index < daily.length - 2) ? " major-day" : ""}`} aria-hidden="true">{day.date.slice(8, 10)}</span>
              </div>
            ))}
          </div>
          {total === 0 && <div className="chart-empty"><Search size={23} /><strong>No requests in this view</strong><span>Try a different problem or a wider date range.</span></div>}
        </div>
      </div>
      <div className="chart-footer"><span id="chart-description">Daily totals by creation date. Hover or focus a bar to explore.</span><span>AUGUST 2026</span></div>
    </section>
  );
}

function RequestsTable({ data, page, onPrevious, onNext }: { data: PulseData; page: number; onPrevious: () => void; onNext: () => void }) {
  return (
    <section id="requests" className="panel requests-panel" aria-labelledby="requests-title">
      <div className="panel-heading">
        <div><div className="eyebrow">BEHIND THE NUMBERS</div><h2 id="requests-title">Explore the requests <span className="count-pill">{number.format(data.summary.total)}</span></h2></div>
        <span className="table-order"><ArrowDown size={13} /> Newest first</span>
      </div>
      {data.requests.length === 0 ? (
        <div className="table-empty"><ListFilter size={28} /><h3>No matching requests</h3><p>Change the filters above to explore another part of the month.</p></div>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Service request records. Scroll for more rows.">
          <table>
            <thead><tr><th scope="col">Created <ArrowDown size={11} /></th><th scope="col">Problem / detail</th><th scope="col">Borough</th><th scope="col">Agency</th><th scope="col">Status</th><th scope="col" className="id-heading">Request ID</th></tr></thead>
            <tbody>
              {data.requests.map((request) => (
                <tr key={request.id}>
                  <td className="created-cell"><strong>{displayDate(request.createdAt)}</strong><span>{displayTime(request.createdAt)}</span></td>
                  <td className="problem-cell"><strong>{request.problem || "Unspecified"}</strong><span title={request.detail ?? undefined}>{request.detail || "No detail provided"}</span></td>
                  <td className="borough-cell">{titleCase(request.borough)}</td>
                  <td><span className="agency-badge">{request.agency || "—"}</span></td>
                  <td><span className={`status-badge ${request.status?.toLowerCase() === "closed" ? "status-closed" : "status-other"}`}><span />{request.status || "Unknown"}</span></td>
                  <td className="request-id">{request.id}{Boolean(request.qualityFlags?.length) && <span className="quality-indicator" tabIndex={0} role="img" aria-label={`Data quality flags: ${request.qualityFlags!.join(", ")}`} title={`Data quality flags: ${request.qualityFlags!.join(", ")}`}><TriangleAlert size={12} /></span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-pagination"><span><b>{number.format(data.requests.length)}</b> requests on page <b>{page}</b><span className="pagination-detail"> · {number.format(data.summary.total)} matching</span></span><div><button type="button" onClick={onPrevious} disabled={page === 1} aria-label="Previous page"><ChevronLeft size={15} /> Previous</button><button type="button" onClick={onNext} disabled={!data.nextCursor} aria-label="Next page">Next <ChevronRight size={15} /></button></div></div>
    </section>
  );
}

export default function PulseDashboard({ initialQuery = {} }: { initialQuery?: InitialQuery }) {
  const [filters, setFilters] = useState<Filters>(() => filtersFromQuery(initialQuery));
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [result, setResult] = useState<{ key: string; data: PulseData | null; error: string | null } | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemError, setProblemError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [activeSection, setActiveSection] = useState("overview");
  const cursor = cursorStack[cursorStack.length - 1];
  const requestKey = JSON.stringify([filters.from, filters.to, filters.problem, cursor, retry]);
  const loading = result?.key !== requestKey;
  const data = result?.data ?? null;
  const error = loading ? null : result?.error ?? null;

  useEffect(() => {
    const onPopState = () => { setFilters(readUrlFilters()); setCursorStack([null]); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/problems?${new URLSearchParams({ from: filters.from, to: filters.to })}`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("Problem list unavailable"); return response.json(); })
      .then((result: ProblemsResponse) => { if (!controller.signal.aborted) { setProblems(result.problems); setProblemError(false); } })
      .catch((reason: Error) => { if (reason.name !== "AbortError") setProblemError(true); });
    return () => controller.abort();
  }, [filters.from, filters.to, retry]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ from: filters.from, to: filters.to });
    if (filters.problem) params.set("problem", filters.problem);
    const urlParams = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}?${urlParams}${window.location.hash}`);
    if (cursor) params.set("cursor", cursor);
    fetch(`/api/pulse?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(typeof result.error?.message === "string" ? result.error.message : typeof result.error === "string" ? result.error : "The local data service could not load this view.");
        return result as PulseData;
      })
      .then((data) => { if (!controller.signal.aborted) setResult({ key: requestKey, data, error: null }); })
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") {
          setResult({ key: requestKey, data: null, error: reason.message || "The local data service could not load this view." });
        }
      });
    return () => controller.abort();
  }, [filters.from, filters.to, filters.problem, cursor, requestKey]);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) setActiveSection(entry.target.id);
    }, { rootMargin: "-10% 0px -65% 0px", threshold: 0 });
    for (const id of ["overview", "map", "requests", "methodology"]) { const element = document.getElementById(id); if (element) observer.observe(element); }
    return () => observer.disconnect();
  }, [data, loading]);

  const updateFilters = useCallback((update: Partial<Filters>) => {
    setFilters((current) => {
      const next = { ...current, ...update };
      if (next.from > next.to) { if (update.from) next.to = next.from; else next.from = next.to; }
      return next;
    });
    setCursorStack([null]);
  }, []);

  const resetFilters = () => { setFilters(INITIAL_FILTERS); setCursorStack([null]); };
  const filtered = filters.problem !== "" || filters.from !== INITIAL_FILTERS.from || filters.to !== INITIAL_FILTERS.to;
  const duration = humanDuration(data?.summary.medianClosureHours ?? null);
  const period = `${displayDate(filters.from)}–${displayDate(filters.to)}`;
  const sourceMeta = data?.meta?.dataFetchedAt;
  const importStatus = data?.meta?.importStatus;

  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">Skip to dashboard</a>
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="NYC Service Pulse, overview"><PulseMark /><span>NYC SERVICE<strong>PULSE<span className="brand-period">.</span></strong></span></a>
        <div className="sidebar-rule" />
        <div className="nav-label">THE OBSERVATORY</div>
        <nav aria-label="Main navigation">
          <a className={activeSection === "overview" ? "active" : ""} href="#overview" aria-label="Overview" onClick={() => setActiveSection("overview")}><ChartNoAxesCombined size={17} /><span>Overview</span><ArrowUpRight size={14} className="nav-arrow" /></a>
          <a className={activeSection === "map" ? "active" : ""} href="#map" aria-label="Request map" onClick={() => setActiveSection("map")}><Map size={17} /><span>Request map</span></a>
          <a className={activeSection === "requests" ? "active" : ""} href="#requests" aria-label="Service requests" onClick={() => setActiveSection("requests")}><Database size={16} /><span>Service requests</span></a>
          <a className={activeSection === "methodology" ? "active" : ""} href="#methodology" aria-label="About the data" onClick={() => setActiveSection("methodology")}><CircleHelp size={17} /><span>About the data</span></a>
        </nav>
        <div className="sidebar-cohort"><span className="cohort-symbol">08<span>/26</span></span><div className="eyebrow">ONE MONTH. FIVE BOROUGHS.</div><p>A closer look at the requests that keep New York moving.</p><a href={SOURCE_URL} target="_blank" rel="noreferrer">Explore the source <ArrowUpRight size={14} /></a></div>
        <div className="sidebar-bottom"><span className="source-dot" /> Public data. Local perspective.<span>BUILT WITH NYC OPEN DATA</span></div>
      </aside>

      <div className="workspace">
        <header className="topbar"><div><span className="topbar-home">Observatory</span><ChevronRight size={12} /><strong>August 2026</strong></div><a href={SOURCE_URL} target="_blank" rel="noreferrer"><span className="topbar-dot" /> NYC 311 open data <ExternalLink size={12} /></a></header>
        <main id="main">
          <section id="overview" className="intro" aria-labelledby="page-title">
            <div><div className="eyebrow intro-eyebrow"><span /> THE RHYTHM OF NEW YORK</div><h1 id="page-title">A month of city life<span>.</span></h1><p>From a noisy block to a street in need. Explore the everyday<br className="desktop-break" /> requests that tell us how New York is doing.</p></div>
            <div className="edition"><span>THE AUGUST EDITION</span><strong>01 <i>—</i> 31</strong><span>AUGUST 2026 <span className="edition-tag">311</span></span></div>
          </section>

          <section className="filter-panel" aria-label="Filter all dashboard data">
            <div className="filter-caption"><SlidersHorizontal size={17} /><span>Refine your view</span></div>
            <div className="filter-fields">
              <div className="filter-field problem-filter"><label htmlFor="problem-filter">Problem type</label><div className="select-wrap"><select id="problem-filter" value={filters.problem} onChange={(event) => updateFilters({ problem: event.target.value })} aria-describedby={problemError ? "problem-error" : undefined}><option value="">All problem types</option>{filters.problem && !problems.some((problem) => problem.name === filters.problem) && <option value={filters.problem}>{filters.problem}</option>}{problems.map((problem) => <option value={problem.name} key={problem.name}>{problem.name} ({number.format(problem.count)})</option>)}</select><ChevronDown size={15} /></div></div>
              <div className="filter-field"><label htmlFor="from-date">From</label><input id="from-date" type="date" min="2026-08-01" max="2026-08-31" value={filters.from} onChange={(event) => { if (/^2026-08-(0[1-9]|[12]\d|3[01])$/.test(event.target.value)) updateFilters({ from: event.target.value }); }} /></div>
              <span className="date-divider" aria-hidden="true">—</span>
              <div className="filter-field"><label htmlFor="to-date">Through</label><input id="to-date" type="date" min="2026-08-01" max="2026-08-31" value={filters.to} onChange={(event) => { if (/^2026-08-(0[1-9]|[12]\d|3[01])$/.test(event.target.value)) updateFilters({ to: event.target.value }); }} /></div>
              <button className="reset-button" type="button" aria-label="Reset filters" onClick={resetFilters} disabled={!filtered}><RotateCcw size={14} /><span>Reset</span></button>
            </div>
            {problemError && <p className="field-error" id="problem-error">Problem types could not load. <button type="button" onClick={() => setRetry((value) => value + 1)}>Try again</button></p>}
          </section>

          <div className="view-context"><span><span className={`context-dot${loading ? " is-loading" : ""}`} /><span aria-live="polite" role="status">{loading ? !data ? "Loading the local August dataset…" : "Updating chart and requests…" : error ? "Local data unavailable" : `${filters.problem || "All problem types"} · ${period}, 2026`}</span></span><span className="scope-note"><Filter size={11} /> Filters apply to every view</span></div>

          {importStatus && importStatus !== "validated" && !error && <div className="import-notice" role="status"><TriangleAlert size={15} /><span><strong>{importStatus === "running" ? "Import in progress." : importStatus === "not_started" ? "The August dataset is not imported yet." : "Import validation is pending."}</strong> {importStatus === "not_started" ? "Run the local import to populate this dashboard." : "Counts may be partial until the full month has been reconciled with the source."}</span></div>}

          {error ? (
            <section className="error-panel" role="alert"><span className="error-icon"><Database size={26} /></span><div><div className="eyebrow">LET’S RECONNECT</div><h2>This view couldn’t load.</h2><p>{error}</p><p className="error-hint">Check that the local database is running and the August import is available.</p><button type="button" className="primary-button" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={15} /> Try again</button></div></section>
          ) : loading && !data ? (
            <div aria-busy="true"><MetricSkeleton /><div className="panel chart-loading"><div className="skeleton-line" /><div className="skeleton-chart" aria-label="Loading daily activity">{Array.from({ length: 31 }, (_, index) => <i key={index} style={{ height: `${25 + (index * 17 % 65)}%` }} />)}</div></div><div className="panel table-loading"><div className="skeleton-line" />{Array.from({ length: 5 }, (_, index) => <div className="skeleton-row" key={index} />)}</div></div>
          ) : data ? (
            <div className={`data-content${loading ? " data-updating" : ""}`} aria-busy={loading} inert={loading}>
              {loading && <div className="updating-overlay"><span><RefreshCw size={15} /> Updating this view</span></div>}
              <section className="metric-grid" aria-label="Request summary">
                <article className="metric-card metric-featured"><div className="metric-label">Total requests <ArrowDownRight size={18} /></div><strong className="metric-value">{number.format(data.summary.total)}</strong><div className="metric-foot"><span className="metric-mini-dot" /> Created within your date range</div><div className="metric-decoration" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></article>
                <article className="metric-card"><div className="metric-label">Marked closed <span className="metric-icon"><Check size={15} /></span></div><strong className="metric-value">{Number(data.summary.closedPercent).toFixed(1)}<span>%</span></strong><div className="metric-foot">{number.format(data.summary.closed)} requests · source status</div><div className="mini-progress" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, data.summary.closedPercent))}%` }} /></div></article>
                <article className="metric-card"><div className="metric-label">Median time to close <span className="metric-icon"><Clock3 size={15} /></span></div><strong className="metric-value">{duration.value}<span>{duration.unit}</span></strong><div className="metric-foot">Across {number.format(data.summary.validClosureCount)} valid closed requests</div><span className="metric-definition">Created → closed</span></article>
                <article className="metric-card"><div className="metric-label">Without coordinates <span className="metric-icon"><MapPinOff size={15} /></span></div><strong className="metric-value">{number.format(data.summary.missingCoordinates)}</strong><div className="metric-foot">Included in totals and table</div><span className="metric-definition">{data.summary.total ? (data.summary.missingCoordinates / data.summary.total * 100).toFixed(1) : "0.0"}% of this view</span></article>
              </section>
              <DailyChart daily={data.daily} total={data.summary.total} />
              <RequestMap filters={filters} missingCoordinates={loading ? null : data.summary.missingCoordinates} />
              <RequestsTable data={data} page={cursorStack.length} onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))} onNext={() => { if (data.nextCursor) setCursorStack((stack) => [...stack, data.nextCursor]); }} />
            </div>
          ) : null}

          <section id="methodology" className="methodology" aria-labelledby="methodology-title">
            <div className="methodology-heading"><span className="method-icon"><ShieldCheck size={18} /></span><div><div className="eyebrow">TRANSPARENCY, BY DESIGN</div><h2 id="methodology-title">A little context goes a long way.</h2></div><a href={SOURCE_URL} target="_blank" rel="noreferrer">View source <ArrowUpRight size={15} /></a></div>
            <div className="methodology-grid"><div><span>01 / THE SCOPE</span><p>311 requests created August 1–31, 2026, across all five boroughs. A local snapshot of a source that continues to change.</p></div><div><span>02 / THE CLOCK</span><p>Source timestamps are preserved and displayed as publisher-local New York time, an assumption. Closing times use valid, nonnegative intervals for closed requests.</p></div><div><span>03 / THE WHOLE PICTURE</span><p>Requests without coordinates remain in the totals and table. “Closed” describes the source status; it does not prove the underlying issue was resolved.</p></div></div>
            {sourceMeta && <p className="source-fetched">Local data fetched: <time dateTime={sourceMeta}>{sourceMeta.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}</time>{data?.meta.lastValidatedAt && <span> · Cohort reconciled against the source</span>}</p>}
          </section>
          <footer className="page-footer"><span><PulseMark small /> NYC SERVICE PULSE</span><span>Small signals. A bigger picture.</span><a href="#overview">Back to top <ArrowUpRight size={13} /></a></footer>
        </main>
      </div>
    </div>
  );
}
