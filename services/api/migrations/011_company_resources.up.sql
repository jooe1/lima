-- Migration: 011_company_resources.up.sql
-- Phase 0 resource authorization:
--   Part A — extend connectors with company-scoped ownership columns.
--   Part B — resource_grants table for fine-grained subject→resource ACLs.

-- ============================================================================
-- Part A: Extend connectors
-- ============================================================================

-- company_id is added nullable so the column can be backfilled before any NOT
-- NULL constraint is applied in a later migration.
-- IF NOT EXISTS guards make each statement idempotent so a retry after a
-- partial run does not fail.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS company_id        UUID REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS owner_scope       TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS policy_profile_id UUID;

-- Backfill company_id from the connector's workspace.
UPDATE connectors c
SET    company_id = w.company_id
FROM   workspaces w
WHERE  c.workspace_id = w.id
AND    c.company_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_connectors_company_id ON connectors (company_id) WHERE company_id IS NOT NULL;

-- ============================================================================
-- Part B: Resource grants
-- ============================================================================

-- Fine-grained ACL entries that bind a subject to an action on a resource.
-- resource_kind examples : 'connector'
-- subject_type examples  : 'user', 'group', 'workspace', 'app',
--                          'service_principal'
-- action examples        : 'query', 'mutate', 'manage', 'bind',
--                          'read_schema'
-- effect                 : 'allow' | 'deny'  (default allow; deny entries
--                          take precedence in evaluation logic)
CREATE TABLE IF NOT EXISTS resource_grants (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
    resource_kind TEXT        NOT NULL,
    resource_id   UUID        NOT NULL,
    subject_type  TEXT        NOT NULL,
    subject_id    UUID        NOT NULL,
    action        TEXT        NOT NULL,
    -- Optional JSON payload that further scopes the grant (e.g. row filters).
    scope_json    JSONB,
    effect        TEXT        NOT NULL DEFAULT 'allow',
    -- Nullable: preserve the grant record even if the creating user is removed.
    created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevents accidental duplicate grants while keeping upsert semantics simple.
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_grants_unique ON resource_grants
    (company_id, resource_kind, resource_id, subject_type, subject_id, action);

CREATE INDEX IF NOT EXISTS idx_resource_grants_resource ON resource_grants (company_id, resource_kind, resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_grants_subject ON resource_grants (subject_type, subject_id);
