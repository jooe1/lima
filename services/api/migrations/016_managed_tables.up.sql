-- Migration: 016_managed_tables.up.sql
-- Replaces the read-only CSV connector type with a fully writable
-- "managed" (Lima Table) connector type. Lima Tables are stored entirely
-- inside Lima's own Postgres database — no external credentials needed.
--
-- Changes:
--   1. Drop CSV-only tables (csv_uploads, app_version_csv_snapshots).
--   2. Rename the 'csv' enum value to 'managed' in connector_type.
--   3. Create managed_table_columns   — column schema for each Lima Table.
--   4. Create managed_table_rows      — individual data rows.
--   5. Create app_version_managed_snapshots — publish-time immutable copy.

-- ---- 1. Drop CSV tables ----------------------------------------------------
DROP TABLE IF EXISTS app_version_csv_snapshots;
DROP TABLE IF EXISTS csv_uploads;

-- ---- 2. Rename connector_type enum value -----------------------------------
-- pg_enum can be updated directly in development; no dependent columns need
-- to be altered because the underlying storage type is unchanged.
UPDATE pg_enum
SET    enumlabel = 'managed'
WHERE  enumtypid = 'connector_type'::regtype
  AND  enumlabel = 'csv';

-- ---- 3. Column definitions for each Lima Table -----------------------------
CREATE TABLE managed_table_columns (
    id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID    NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    -- Logical type hint used by the UI: text | number | boolean | date
    col_type     TEXT    NOT NULL DEFAULT 'text',
    nullable     BOOLEAN NOT NULL DEFAULT true,
    -- Display and CSV export order
    col_order    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (connector_id, name)
);

CREATE INDEX ON managed_table_columns (connector_id, col_order);

-- ---- 4. Individual data rows -----------------------------------------------
CREATE TABLE managed_table_rows (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID        NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    -- Row data stored as a JSON object keyed by column name.
    data         JSONB       NOT NULL DEFAULT '{}',
    created_by   UUID        NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Soft-deleted rows are hidden from queries but kept for audit purposes.
    deleted_at   TIMESTAMPTZ
);

CREATE INDEX ON managed_table_rows (connector_id, created_at) WHERE deleted_at IS NULL;

-- ---- 5. Publish-time managed table snapshot --------------------------------
-- At publish time the API freezes a verbatim copy of the column definitions
-- and row data so that published apps serve deterministic, immutable data
-- even if the live table is later edited or deleted.
CREATE TABLE app_version_managed_snapshots (
    app_version_id UUID NOT NULL REFERENCES app_versions(id) ON DELETE CASCADE,
    connector_name TEXT NOT NULL,
    columns        JSONB NOT NULL DEFAULT '[]',
    rows           JSONB NOT NULL DEFAULT '[]',
    total_rows     INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (app_version_id, connector_name)
);

CREATE INDEX ON app_version_managed_snapshots (app_version_id);
