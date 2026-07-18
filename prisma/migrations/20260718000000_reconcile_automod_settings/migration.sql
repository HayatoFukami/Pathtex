-- Reconcile databases that applied the original migration before max_lines
-- was included in the AutomodSettings model.
ALTER TABLE "automod_settings"
  ADD COLUMN IF NOT EXISTS "max_lines" SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'automod_settings_max_lines_valid'
      AND conrelid = 'automod_settings'::regclass
  ) THEN
    ALTER TABLE "automod_settings"
      ADD CONSTRAINT "automod_settings_max_lines_valid"
      CHECK ("max_lines" IS NULL OR "max_lines" BETWEEN 1 AND 500);
  END IF;
END
$$;
