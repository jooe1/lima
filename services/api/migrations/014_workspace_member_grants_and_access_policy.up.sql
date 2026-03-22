-- Migration: 014_workspace_member_grants_and_access_policy.up.sql
-- Introduces explicit workspace-member grant tracking, workspace access policy
-- rules, company-wide synthetic groups, and the required data backfills.

CREATE TABLE workspace_member_grants (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         workspace_role NOT NULL,
    grant_source TEXT        NOT NULL,
    source_ref   TEXT        NOT NULL,
    created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, user_id, grant_source, source_ref),
    CHECK (grant_source IN ('manual', 'policy', 'idp', 'system_bootstrap')),
    CHECK (btrim(source_ref) <> '')
);

CREATE INDEX idx_workspace_member_grants_workspace_user ON workspace_member_grants (workspace_id, user_id);
CREATE INDEX idx_workspace_member_grants_user ON workspace_member_grants (user_id);

CREATE TABLE workspace_access_policy_rules (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    match_kind   TEXT        NOT NULL,
    group_id     UUID        REFERENCES company_groups(id) ON DELETE CASCADE,
    role         workspace_role NOT NULL,
    created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, match_kind, group_id),
    CHECK (match_kind IN ('all_company_members', 'company_group', 'idp_group')),
    CHECK (
        (match_kind = 'all_company_members' AND group_id IS NULL)
        OR (match_kind IN ('company_group', 'idp_group') AND group_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_workspace_access_policy_rules_all_company_members
    ON workspace_access_policy_rules (workspace_id, match_kind)
    WHERE group_id IS NULL;
CREATE INDEX idx_workspace_access_policy_rules_workspace ON workspace_access_policy_rules (workspace_id);
CREATE INDEX idx_workspace_access_policy_rules_group ON workspace_access_policy_rules (group_id) WHERE group_id IS NOT NULL;

-- Legacy installs created company_groups.source_type with the enum
-- group_source_type. Normalize that column to TEXT before introducing the
-- new source labels used by this migration.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   information_schema.columns
        WHERE  table_schema = 'public'
        AND    table_name = 'company_groups'
        AND    column_name = 'source_type'
        AND    udt_name = 'group_source_type'
    ) THEN
        ALTER TABLE company_groups
            ALTER COLUMN source_type DROP DEFAULT;

        ALTER TABLE company_groups
            ALTER COLUMN source_type TYPE TEXT
            USING source_type::text;

        ALTER TABLE company_groups
            ALTER COLUMN source_type SET DEFAULT 'manual';
    END IF;
END $$;

-- Normalize legacy IdP group source labels.
UPDATE company_groups
SET    source_type = 'idp',
       updated_at = now()
WHERE  source_type = 'external';

-- Create one company-wide synthetic group per company.
INSERT INTO company_groups (company_id, name, slug, source_type, external_ref)
SELECT c.id, 'All Employees', 'system-all-employees', 'company_synthetic', 'all-employees'
FROM   companies c
ON CONFLICT (company_id, slug) DO UPDATE
SET    name = EXCLUDED.name,
       source_type = EXCLUDED.source_type,
       external_ref = EXCLUDED.external_ref,
       updated_at = now();

-- Backfill every existing user into the company-wide synthetic group.
INSERT INTO group_memberships (group_id, user_id)
SELECT cg.id, u.id
FROM   users u
JOIN   company_groups cg ON  cg.company_id = u.company_id
                        AND cg.source_type = 'company_synthetic'
                        AND cg.slug = 'system-all-employees'
ON CONFLICT (group_id, user_id) DO NOTHING;

-- Backfill company_member role bindings for all existing users.
INSERT INTO company_role_bindings (company_id, subject_type, subject_id, role)
SELECT u.company_id, 'user', u.id, 'company_member'
FROM   users u
ON CONFLICT (company_id, subject_type, subject_id, role) DO NOTHING;

-- Bootstrap one company_admin where a company currently has none.
WITH ranked_users AS (
    SELECT u.company_id,
           u.id AS user_id,
           ROW_NUMBER() OVER (PARTITION BY u.company_id ORDER BY u.created_at, u.id) AS rank_in_company
    FROM   users u
),
companies_without_admin AS (
    SELECT c.id AS company_id
    FROM   companies c
    WHERE  NOT EXISTS (
        SELECT 1
        FROM   company_role_bindings crb
        WHERE  crb.company_id = c.id
        AND    crb.role = 'company_admin'
    )
)
INSERT INTO company_role_bindings (company_id, subject_type, subject_id, role)
SELECT ru.company_id, 'user', ru.user_id, 'company_admin'
FROM   ranked_users ru
JOIN   companies_without_admin cwa ON cwa.company_id = ru.company_id
WHERE  ru.rank_in_company = 1
ON CONFLICT (company_id, subject_type, subject_id, role) DO NOTHING;

-- Backfill existing effective workspace memberships into explicit manual grants.
INSERT INTO workspace_member_grants (workspace_id, user_id, role, grant_source, source_ref, created_by, created_at, updated_at)
SELECT wm.workspace_id,
       wm.user_id,
       wm.role,
       'manual',
       'manual',
       NULL,
       wm.created_at,
       wm.updated_at
FROM   workspace_members wm
ON CONFLICT (workspace_id, user_id, grant_source, source_ref) DO UPDATE
SET    role = EXCLUDED.role,
       updated_at = EXCLUDED.updated_at;

-- Ensure workspace synthetic groups exist for every workspace.
INSERT INTO company_groups (company_id, name, slug, source_type, external_ref)
SELECT w.company_id,
       'Workspace: ' || w.name,
       'ws-' || REPLACE(w.id::text, '-', ''),
       'workspace_sync',
       w.id::text
FROM   workspaces w
ON CONFLICT (company_id, slug) DO UPDATE
SET    name = EXCLUDED.name,
       source_type = EXCLUDED.source_type,
       external_ref = EXCLUDED.external_ref,
       updated_at = now();

-- Rebuild workspace synthetic-group memberships from current effective workspace_members.
DELETE FROM group_memberships gm
USING  company_groups cg
WHERE  gm.group_id = cg.id
AND    cg.source_type = 'workspace_sync';

INSERT INTO group_memberships (group_id, user_id)
SELECT cg.id, wm.user_id
FROM   workspace_members wm
JOIN   workspaces w ON w.id = wm.workspace_id
JOIN   company_groups cg ON  cg.company_id = w.company_id
                        AND cg.source_type = 'workspace_sync'
                        AND cg.external_ref = w.id::text
ON CONFLICT (group_id, user_id) DO NOTHING;