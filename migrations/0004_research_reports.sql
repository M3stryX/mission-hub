DO $$
BEGIN
  CREATE TYPE run_purpose AS ENUM (
    'research',
    'implementation',
    'runtime_verification',
    'independent_review',
    'incident_analysis',
    'maintenance',
    'migration',
    'benchmark',
    'other'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TYPE summary_type ADD VALUE IF NOT EXISTS 'research_report';

ALTER TABLE execution_runs
  ADD COLUMN IF NOT EXISTS purpose run_purpose;

CREATE INDEX IF NOT EXISTS execution_runs_mission_purpose_idx
  ON execution_runs(mission_id, purpose);

ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS metadata_json JSONB;