CREATE OR REPLACE FUNCTION trevra_refresh_publisher_reputation(target_publisher_id TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  release_count DOUBLE PRECISION := 0;
  run_count DOUBLE PRECISION := 0;
  success_count DOUBLE PRECISION := 0;
  install_count DOUBLE PRECISION := 0;
  is_verified BOOLEAN := FALSE;
BEGIN
  SELECT verified INTO is_verified FROM module_publishers WHERE id=target_publisher_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COUNT(*) INTO release_count
  FROM module_releases release
  JOIN module_packages package ON package.module_id=release.module_id
  WHERE package.publisher_id=target_publisher_id AND release.status='verified';

  SELECT COALESCE(SUM(metrics.total_runs),0),COALESCE(SUM(metrics.successful_runs),0),COALESCE(SUM(metrics.active_installations),0)
  INTO run_count,success_count,install_count
  FROM module_packages package
  LEFT JOIN module_usage_metrics metrics ON metrics.module_id=package.module_id
  WHERE package.publisher_id=target_publisher_id;

  UPDATE module_publishers SET reputation_score=LEAST(100,
    CASE WHEN is_verified THEN 25 ELSE 0 END +
    LEAST(15,release_count*3) +
    LEAST(25,LN(1+run_count)*5) +
    CASE WHEN run_count>=10 THEN (success_count/NULLIF(run_count,0))*25 ELSE 0 END +
    LEAST(10,LN(1+install_count)*4)
  ),updated_at=CURRENT_TIMESTAMP WHERE id=target_publisher_id;
END $$;

CREATE OR REPLACE FUNCTION trevra_refresh_publisher_for_module()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE publisher TEXT;
BEGIN
  SELECT publisher_id INTO publisher FROM module_packages WHERE module_id=COALESCE(NEW.module_id,OLD.module_id);
  IF publisher IS NOT NULL THEN PERFORM trevra_refresh_publisher_reputation(publisher); END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

DROP TRIGGER IF EXISTS trevra_reputation_from_usage ON module_usage_metrics;
CREATE TRIGGER trevra_reputation_from_usage
AFTER INSERT OR UPDATE ON module_usage_metrics
FOR EACH ROW EXECUTE FUNCTION trevra_refresh_publisher_for_module();

DROP TRIGGER IF EXISTS trevra_reputation_from_release ON module_releases;
CREATE TRIGGER trevra_reputation_from_release
AFTER INSERT OR UPDATE OF status ON module_releases
FOR EACH ROW EXECUTE FUNCTION trevra_refresh_publisher_for_module();

CREATE OR REPLACE FUNCTION trevra_refresh_updated_publisher()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM trevra_refresh_publisher_reputation(NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trevra_reputation_from_verification ON module_publishers;
CREATE TRIGGER trevra_reputation_from_verification
AFTER UPDATE OF verified ON module_publishers
FOR EACH ROW WHEN (OLD.verified IS DISTINCT FROM NEW.verified)
EXECUTE FUNCTION trevra_refresh_updated_publisher();
