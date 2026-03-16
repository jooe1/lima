-- Migration: 008_audit_retention.up.sql
-- Phase 7: enterprise hardening — audit retention, append-only enforcement,
-- and performance indexes.

-- ---- Retention column ------------------------------------------------------
-- expires_at: when set, records are eligible for pruning by the cleanup job.
-- NULL means retain indefinitely (default for compliance-sensitive installs).
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS
    expires_at TIMESTAMPTZ;

-- Index supports the prune query (DELETE WHERE expires_at < now()).
CREATE INDEX IF NOT EXISTS audit_events_expires_at_idx
    ON audit_events (expires_at)
    WHERE expires_at IS NOT NULL;

-- ---- Append-only rule -------------------------------------------------------
-- Prevent any UPDATE or DELETE on audit_events rows whose expires_at has NOT
-- been reached yet (i.e. active records).  This is enforced at the DB level
-- so even a compromised application user cannot tamper with live audit data.
-- (Rows with expires_at < now() are removed only by the scheduled prune job
--  via a dedicated database role in production installations.)
CREATE OR REPLACE RULE audit_events_no_update AS
    ON UPDATE TO audit_events DO INSTEAD NOTHING;

CREATE OR REPLACE RULE audit_events_no_delete_active AS
    ON DELETE TO audit_events
    WHERE (OLD.expires_at IS NULL OR OLD.expires_at >= now())
    DO INSTEAD NOTHING;

-- ---- Composite performance index for export queries -------------------------
-- Covers the common export pattern: WHERE workspace_id = ? AND created_at BETWEEN ? AND ?
-- The existing (workspace_id, created_at DESC) index covers the list endpoint;
-- this one covers the ascending export scan.
CREATE INDEX IF NOT EXISTS audit_events_workspace_created_asc_idx
    ON audit_events (workspace_id, created_at ASC);

-- ---- Helper function to apply a retention policy ---------------------------
-- Sets expires_at = created_at + retention_days for all rows in a workspace
-- that do not yet have an expiry.  Call this after changing a workspace's
-- retention policy setting.
CREATE OR REPLACE FUNCTION apply_audit_retention(
    p_workspace_id UUID,
    p_retention_days INT
) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    affected BIGINT;
BEGIN
    UPDATE audit_events
       SET expires_at = created_at + (p_retention_days || ' days')::INTERVAL
     WHERE workspace_id = p_workspace_id
       AND expires_at IS NULL;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END;
$$;
