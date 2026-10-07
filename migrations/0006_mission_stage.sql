-- Mission #294 lifecycle gates — mission stage enum + column.
-- Non-destructive: implicit backfill only (ADD COLUMN ... NOT NULL DEFAULT),
-- no UPDATE statements anywhere.
DO $$
BEGIN
  CREATE TYPE mission_stage AS ENUM (
    'research',
    'architecture',
    'plan',
    'execution',
    'done'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS stage mission_stage NOT NULL DEFAULT 'research';
