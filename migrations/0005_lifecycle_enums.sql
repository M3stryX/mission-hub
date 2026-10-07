-- Mission #294 lifecycle gates — enum value appends (append-only, forward-only).
-- Single owner, order-sensitive: values must be appended LAST.
DO $$
BEGIN
  ALTER TYPE run_purpose ADD VALUE IF NOT EXISTS 'architecture';
  ALTER TYPE run_purpose ADD VALUE IF NOT EXISTS 'planning';
  ALTER TYPE run_purpose ADD VALUE IF NOT EXISTS 'jev_gate';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TYPE summary_type ADD VALUE IF NOT EXISTS 'plan_summary';
  ALTER TYPE summary_type ADD VALUE IF NOT EXISTS 'plan_approval';
  ALTER TYPE summary_type ADD VALUE IF NOT EXISTS 'jev_decision';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
