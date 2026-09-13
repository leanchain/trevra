-- Deterministic multi-slide evidence carousels are first-class content assets.
ALTER TABLE content_assets
  DROP CONSTRAINT IF EXISTS content_assets_format_check;
ALTER TABLE content_assets
  ADD CONSTRAINT content_assets_format_check
  CHECK (format IN ('text_post','evidence_card','carousel','market_pulse','report'));
