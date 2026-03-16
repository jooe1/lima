-- Migration: 005_create_approvals_audit.up.sql
-- Write-approval queue (FR-15) and audit event log.

-- ---- Approvals (gating every AI-generated mutation) -----------------------
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE approvals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    app_id        UUID REFERENCES apps(id) ON DELETE SET NULL,
    connector_id  UUID REFERENCES connectors(id) ON DELETE SET NULL,
    -- Human-readable description of the action that will be executed
    description   TEXT NOT NULL,
    -- The full mutation payload (connector type, query, params) — stored
    -- encrypted to avoid exposing sensitive query params at rest
    encrypted_payload BYTEA NOT NULL,
    status        approval_status NOT NULL DEFAULT 'pending',
    requested_by  UUID NOT NULL REFERENCES users(id),
    reviewed_by   UUID REFERENCES users(id),
    reviewed_at   TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON approvals (workspace_id, status);
CREATE INDEX ON approvals (app_id);

-- ---- Audit events ----------------------------------------------------------
-- append-only; no UPDATE or DELETE allowed (enforced via DB policy in Phase 7)
CREATE TABLE audit_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type   TEXT NOT NULL,
    resource_type TEXT,
    resource_id  UUID,
    metadata     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON audit_events (workspace_id, created_at DESC);
CREATE INDEX ON audit_events (workspace_id, event_type);
CREATE INDEX ON audit_events (workspace_id, resource_type, resource_id);
