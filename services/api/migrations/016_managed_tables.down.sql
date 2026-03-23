-- Migration: 016_managed_tables.down.sql
DROP TABLE IF EXISTS app_version_managed_snapshots;
DROP TABLE IF EXISTS managed_table_rows;
DROP TABLE IF EXISTS managed_table_columns;

-- Revert 'managed' back to 'csv' in the connector_type enum.
UPDATE pg_enum
SET    enumlabel = 'csv'
WHERE  enumtypid = 'connector_type'::regtype
  AND  enumlabel = 'managed';

-- Restore CSV tables.
CREATE TABLE csv_uploads (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    filename     TEXT,
    columns      JSONB NOT NULL DEFAULT '[]',
    rows         JSONB NOT NULL DEFAULT '[]',
    total_rows   INT  NOT NULL DEFAULT 0,
    uploaded_by  UUID NOT NULL REFERENCES users(id),
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON csv_uploads (connector_id, uploaded_at DESC);

CREATE TABLE app_version_csv_snapshots (
    app_version_id UUID NOT NULL REFERENCES app_versions(id) ON DELETE CASCADE,
    connector_name TEXT NOT NULL,
    csv_upload_id  UUID NOT NULL REFERENCES csv_uploads(id),
    PRIMARY KEY (app_version_id, connector_name)
);

CREATE INDEX ON app_version_csv_snapshots (app_version_id);
