-- Optional owner-controlled CTA destination for immutable public reports.
-- Blank reports keep the deployment's normal hosted-workspace CTA.

ALTER TABLE content_public_reports
  ADD COLUMN IF NOT EXISTS cta_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='content_public_reports_cta_url_http_check'
      AND conrelid='content_public_reports'::regclass
  ) THEN
    ALTER TABLE content_public_reports
      ADD CONSTRAINT content_public_reports_cta_url_http_check
      CHECK (cta_url IS NULL OR cta_url ~* '^https?://') NOT VALID;
  END IF;
END $$;
