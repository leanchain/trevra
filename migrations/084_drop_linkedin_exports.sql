-- The legacy campaign system owned this table alone: rendered CSV/JSON export
-- blobs for `/api/linkedin/campaigns/:id/export`. Both the route and the
-- renderer are gone, and the managed campaign path drives the worker directly
-- instead of producing files, so nothing reads these rows.
DROP TABLE IF EXISTS linkedin_exports;
