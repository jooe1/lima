-- Migration: 003_create_connectors.up.sql
-- Data connector config and encrypted credential storage.

CREATE TYPE connector_type AS ENUM ('postgres', 'mysql', 'mssql', 'rest', 'graphql', 'csv');

CREATE TABLE connectors (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    type                  connector_type NOT NULL,
    -- AES-GCM encrypted JSON blob; decrypted by the API service at runtime
    -- The encryption key is sourced from the environment, never stored in DB
    encrypted_credentials BYTEA NOT NULL,
    -- Cached schema discovery result (nullable — populated on first discovery)
    schema_cache          JSONB,
    schema_cached_at      TIMESTAMPTZ,
    created_by            UUID NOT NULL REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON connectors (workspace_id);
CREATE INDEX ON connectors (workspace_id, type);
