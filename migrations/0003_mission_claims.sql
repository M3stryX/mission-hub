CREATE TYPE claim_release_reason AS ENUM (
  'completed',
  'failed',
  'abandoned',
  'expired'
);

CREATE TABLE mission_claims (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  agent TEXT NOT NULL,
  lease_seconds INTEGER NOT NULL CHECK (lease_seconds > 0),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason claim_release_reason,
  CONSTRAINT mission_claims_time_order CHECK (
    expires_at > claimed_at
    AND (released_at IS NULL OR released_at >= claimed_at)
    AND ((released_at IS NULL) = (release_reason IS NULL))
  )
);

-- At most one non-released claim row per mission (includes expired-but-not-released).
CREATE UNIQUE INDEX mission_claims_one_open_per_mission
  ON mission_claims(mission_id)
  WHERE released_at IS NULL;

CREATE INDEX mission_claims_expires_idx
  ON mission_claims(expires_at)
  WHERE released_at IS NULL;

CREATE INDEX mission_claims_run_idx ON mission_claims(run_id);
