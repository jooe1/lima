-- Migration: 012_synthetic_workspace_groups.up.sql
-- Backfills one 'workspace_sync' company_group per workspace and
-- migrates workspace_members into group_memberships.
--
-- Slug format: 'ws-' || workspace_id with hyphens stripped (32 hex chars).
-- This stays short and is stable across re-runs.
-- ON CONFLICT DO NOTHING makes the migration safe to re-apply.

-- Create one synthetic company group per workspace.
INSERT INTO company_groups (id, company_id, name, slug, source_type, external_ref)
SELECT
    gen_random_uuid(),
    w.company_id,
    'Workspace: ' || w.name,
    'ws-' || REPLACE(w.id::text, '-', ''),
    'workspace_sync',
    w.id::text
FROM workspaces w
ON CONFLICT (company_id, slug) DO NOTHING;

-- Populate group memberships from workspace_members.
INSERT INTO group_memberships (group_id, user_id)
SELECT cg.id, wm.user_id
FROM   workspace_members wm
JOIN   workspaces     w  ON  w.id          = wm.workspace_id
JOIN   company_groups cg ON  cg.external_ref = w.id::text
                         AND cg.source_type  = 'workspace_sync'
ON CONFLICT (group_id, user_id) DO NOTHING;
