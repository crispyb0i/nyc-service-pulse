-- Source dates are floating local timestamps. Never silently attach a UTC timezone.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS import_runs (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('full', 'refresh')),
  status text NOT NULL CHECK (status IN ('running', 'interrupted', 'failed', 'validated')),
  phase text NOT NULL DEFAULT 'full',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_since timestamptz,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  phase_snapshot jsonb,
  validation jsonb,
  rows_processed bigint NOT NULL DEFAULT 0,
  batches_processed integer NOT NULL DEFAULT 0,
  error text
);

CREATE TABLE IF NOT EXISTS service_requests (
  id text PRIMARY KEY,
  created_at timestamp without time zone,
  closed_at timestamp without time zone,
  created_raw text,
  closed_raw text,
  status text NOT NULL,
  agency text NOT NULL,
  problem text NOT NULL,
  detail text,
  borough text,
  latitude double precision,
  longitude double precision,
  geom geometry(Point,4326),
  source_updated_at timestamptz,
  fetched_at timestamptz NOT NULL,
  quality_flags text[] NOT NULL DEFAULT '{}',
  import_run_id uuid NOT NULL REFERENCES import_runs(id)
);

CREATE INDEX IF NOT EXISTS requests_created_id ON service_requests (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS requests_problem_created_id ON service_requests (problem, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS import_checkpoints (
  run_id uuid NOT NULL REFERENCES import_runs(id),
  phase text NOT NULL,
  day date NOT NULL,
  last_id text,
  completed boolean NOT NULL DEFAULT false,
  rows_processed bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, phase, day)
);

-- The full pass records membership independently of upserts. This allows a validated
-- full reconciliation to remove records deleted from or moved out of the cohort.
CREATE TABLE IF NOT EXISTS import_seen (
  run_id uuid NOT NULL REFERENCES import_runs(id),
  id text NOT NULL,
  day date NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX IF NOT EXISTS import_seen_run_day ON import_seen (run_id, day);

-- Idempotent upgrade for projects migrated before label normalization.
ALTER TABLE service_requests ALTER COLUMN status SET NOT NULL;
ALTER TABLE service_requests ALTER COLUMN agency SET NOT NULL;
ALTER TABLE service_requests ALTER COLUMN problem SET NOT NULL;

-- Freshness metadata uses two MAX queries on every response, including narrow filters.
CREATE INDEX IF NOT EXISTS requests_fetched_at ON service_requests (fetched_at);
CREATE INDEX IF NOT EXISTS requests_source_updated_at ON service_requests (source_updated_at);

-- The chart groups by calendar day; expression statistics prevent estimating one
-- group per timestamp and sorting hundreds of thousands of rows unnecessarily.
CREATE STATISTICS IF NOT EXISTS requests_created_day_stats ON (created_at::date) FROM service_requests;
ANALYZE service_requests;

-- Viewport queries exclude missing coordinates but retain those requests elsewhere.
CREATE INDEX IF NOT EXISTS requests_geom ON service_requests USING gist (geom) WHERE geom IS NOT NULL;
