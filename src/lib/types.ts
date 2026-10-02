export const COHORT = { from: "2026-08-01", to: "2026-08-31" } as const;
export const PAGE_SIZE = 50;

export type Filters = { from: string; to: string; problem: string | null };
export type RequestCursor = { createdAt: string; id: string };
export type PulseQuery = Filters & { cursor: RequestCursor | null };
export type ServiceRequest = {
  id: string;
  createdAt: string;
  closedAt: string | null;
  status: string;
  agency: string;
  problem: string;
  detail: string | null;
  borough: string | null;
  qualityFlags: string[];
};
export type PulseSummary = {
  total: number;
  closed: number;
  closedPercent: number;
  medianClosureHours: number | null;
  validClosureCount: number;
  missingCoordinates: number;
};
export type ImportStatus = "running" | "interrupted" | "failed" | "validated" | "not_started";
export type PulseResponse = {
  summary: PulseSummary;
  daily: { date: string; count: number }[];
  requests: ServiceRequest[];
  nextCursor: string | null;
  meta: {
    filters: Filters;
    pageSize: number;
    source: string;
    timestampConvention: string;
    dataFetchedAt: string | null;
    latestSourceUpdateAt: string | null;
    importStatus: ImportStatus;
    importRunId: string | null;
    lastValidatedAt: string | null;
    generatedAt: string;
  };
};
export type ProblemsResponse = { problems: { name: string; count: number }[] };
export type ApiErrorResponse = { error: { code: string; message: string } };
