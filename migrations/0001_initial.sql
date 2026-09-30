CREATE TYPE mission_status AS ENUM ('backlog', 'todo', 'in_progress', 'review', 'done', 'blocked');
CREATE TYPE source_kind AS ENUM ('doc', 'link');
CREATE TYPE session_status AS ENUM ('OPEN', 'CLOSED', 'ABORTED');
CREATE TYPE run_status AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE review_state AS ENUM ('NONE', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');
CREATE TYPE summary_type AS ENUM ('agent_self_report', 'reviewer_validated', 'operator_note');

CREATE TABLE missions (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  status mission_status NOT NULL DEFAULT 'backlog',
  priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  due_at TEXT,
  source TEXT,
  tags TEXT,
  recurrence TEXT,
  parent_id INTEGER REFERENCES missions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))
  ) STORED
);

CREATE INDEX missions_status_idx ON missions(status);
CREATE INDEX missions_parent_idx ON missions(parent_id);
CREATE INDEX missions_search_gin_idx ON missions USING GIN(search_vector);

CREATE TABLE mission_checklist_items (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mission_checklist_items_mission_position_idx
  ON mission_checklist_items(mission_id, position);

CREATE TABLE mission_sources (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  path TEXT NOT NULL,
  kind source_kind NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mission_sources_mission_path_unique UNIQUE (mission_id, path)
);

CREATE TABLE mission_events (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  actor TEXT NOT NULL DEFAULT 'system',
  kind TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mission_events_mission_created_idx
  ON mission_events(mission_id, created_at);

CREATE TABLE agent_sessions (
  id SERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  agent TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  correlation_id TEXT,
  status session_status NOT NULL DEFAULT 'OPEN',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  CONSTRAINT agent_sessions_client_runtime_external_unique
    UNIQUE (client_id, runtime, external_session_id),
  CONSTRAINT agent_sessions_time_order
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX agent_sessions_correlation_idx ON agent_sessions(correlation_id);

CREATE TABLE execution_runs (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES missions(id),
  session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
  client_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  agent TEXT NOT NULL,
  external_run_id TEXT NOT NULL,
  correlation_id TEXT,
  provider TEXT,
  model TEXT,
  status run_status NOT NULL DEFAULT 'PENDING',
  review_state review_state NOT NULL DEFAULT 'NONE',
  metadata_json JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT execution_runs_client_runtime_external_unique
    UNIQUE (client_id, runtime, external_run_id),
  CONSTRAINT execution_runs_time_order
    CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX execution_runs_mission_idx ON execution_runs(mission_id);
CREATE INDEX execution_runs_session_idx ON execution_runs(session_id);
CREATE INDEX execution_runs_correlation_idx ON execution_runs(correlation_id);

CREATE TABLE execution_events (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  client_id TEXT,
  kind TEXT NOT NULL,
  status_from run_status,
  status_to run_status,
  payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX execution_events_run_created_idx
  ON execution_events(run_id, created_at);

CREATE TABLE summaries (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  type summary_type NOT NULL,
  content TEXT NOT NULL,
  actor TEXT NOT NULL,
  client_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX summaries_run_created_idx ON summaries(run_id, created_at);

CREATE TABLE evidence (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  uri TEXT NOT NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX evidence_run_created_idx ON evidence(run_id, created_at);
