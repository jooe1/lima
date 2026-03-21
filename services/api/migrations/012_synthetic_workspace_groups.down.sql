-- Migration: 012_synthetic_workspace_groups.down.sql
-- Reverses 012_synthetic_workspace_groups.up.sql.
-- Removes backfilled memberships and synthetic groups; does not touch
-- any manually created groups or memberships.

-- Remove memberships that belong to workspace_sync groups.
DELETE FROM group_memberships
WHERE  group_id IN (
    SELECT id FROM company_groups WHERE source_type = 'workspace_sync'
);

-- Remove the synthetic groups themselves.
DELETE FROM company_groups
WHERE  source_type = 'workspace_sync';
