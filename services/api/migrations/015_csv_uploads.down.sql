-- Migration: 015_csv_uploads.down.sql
DROP TABLE IF EXISTS app_version_csv_snapshots;
DROP TABLE IF EXISTS csv_uploads;

-- Restore row data to schema_cache from whateve the current state is.
-- This is best-effort; the actual row data from the csv_uploads table
-- cannot be recovered into schema_cache once this down migration runs.
