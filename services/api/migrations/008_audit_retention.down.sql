-- Migration: 008_audit_retention.down.sql

DROP FUNCTION IF EXISTS apply_audit_retention(UUID, INT);
DROP INDEX IF EXISTS audit_events_workspace_created_asc_idx;
DROP RULE IF EXISTS audit_events_no_delete_active ON audit_events;
DROP RULE IF EXISTS audit_events_no_update ON audit_events;
DROP INDEX IF EXISTS audit_events_expires_at_idx;
ALTER TABLE audit_events DROP COLUMN IF EXISTS expires_at;
