-- Migration: 002_create_apps_versions.up.sql
-- Apps, draft/publish lifecycle, and version snapshots.

-- ---- Apps -------------------------------------------------------------------
CREATE TYPE app_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE apps (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    status       app_status NOT NULL DEFAULT 'draft',
    -- Latest draft DSL source (Aura flat DSL)
    dsl_source   TEXT NOT NULL DEFAULT '',
    created_by   UUID NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON apps (workspace_id);
CREATE INDEX ON apps (workspace_id, status);

-- ---- App versions (immutable publish snapshots) ----------------------------
CREATE TABLE app_versions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id       UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    version_num  INT NOT NULL,
    dsl_source   TEXT NOT NULL,
    published_by UUID NOT NULL REFERENCES users(id),
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, version_num)
);

CREATE INDEX ON app_versions (app_id);
