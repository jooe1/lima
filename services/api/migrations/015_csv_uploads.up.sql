-- Migration: 015_csv_uploads.up.sql
-- Dedicated storage for CSV connector uploads and publish-time snapshots.
--
-- Motivation:
--   Previously, CSV row data was stored in connectors.schema_cache (JSONB),
--   which was designed for schema-discovery metadata, not row storage.
--   Problems with the old approach:
--     1. schema_cache purpose-built for schema metadata, not data rows.
--     2. Only the first 100 rows were persisted; the rest silently discarded.
--     3. Published apps shared a live pointer to schema_cache, so updating
--        or deleting a CSV connector would silently break a published app.
--     4. Every query against connectors loaded fat JSONB blobs.

-- ---- csv_uploads ------------------------------------------------------------
-- Stores the actual row data for each CSV import. Multiple uploads are
-- supported per connector; the most recent upload is used at runtime unless
-- an explicit snapshot is requested.
CREATE TABLE csv_uploads (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    filename     TEXT,
    -- Column metadata: [{name, type, nullable}, ...]
    columns      JSONB NOT NULL DEFAULT '[]',
    -- Full row data as an array of objects keyed by column name.
    rows         JSONB NOT NULL DEFAULT '[]',
    total_rows   INT  NOT NULL DEFAULT 0,
    uploaded_by  UUID NOT NULL REFERENCES users(id),
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON csv_uploads (connector_id, uploaded_at DESC);

-- ---- Migrate existing CSV data from schema_cache → csv_uploads --------------
-- Only migrates connectors that have both 'columns' and 'rows' in schema_cache.
INSERT INTO csv_uploads (connector_id, filename, columns, rows, total_rows, uploaded_by, uploaded_at)
SELECT
    id,
    NULL,
    schema_cache->'columns',
    schema_cache->'rows',
    COALESCE((schema_cache->>'total_rows')::int, jsonb_array_length(schema_cache->'rows')),
    created_by,
    COALESCE(schema_cached_at, created_at)
FROM connectors
WHERE type = 'csv'
  AND schema_cache IS NOT NULL
  AND schema_cache ? 'columns'
  AND schema_cache ? 'rows'
  AND jsonb_array_length(schema_cache->'rows') > 0;

-- Strip rows from schema_cache for CSV connectors. Keep only column metadata.
UPDATE connectors
SET schema_cache = jsonb_build_object(
    'type',       schema_cache->>'type',
    'columns',    schema_cache->'columns',
    'total_rows', COALESCE((schema_cache->>'total_rows')::int, jsonb_array_length(schema_cache->'rows'))
)
WHERE type = 'csv'
  AND schema_cache IS NOT NULL
  AND schema_cache ? 'rows';

-- ---- app_version_csv_snapshots ----------------------------------------------
-- Captures which CSV upload was live for each connector name at the moment
-- an app version was published. Allows published apps to serve deterministic,
-- immutable data even after the underlying connector is updated or deleted.
CREATE TABLE app_version_csv_snapshots (
    app_version_id UUID NOT NULL REFERENCES app_versions(id) ON DELETE CASCADE,
    connector_name TEXT NOT NULL,
    csv_upload_id  UUID NOT NULL REFERENCES csv_uploads(id),
    PRIMARY KEY (app_version_id, connector_name)
);

CREATE INDEX ON app_version_csv_snapshots (app_version_id);
