-- Migration: 014_workspace_member_grants_and_access_policy.down.sql

DELETE FROM group_memberships
WHERE  group_id IN (
    SELECT id
    FROM   company_groups
    WHERE  source_type = 'company_synthetic'
    AND    slug = 'system-all-employees'
);

DELETE FROM company_groups
WHERE  source_type = 'company_synthetic'
AND    slug = 'system-all-employees';

UPDATE company_groups
SET    source_type = 'external',
       updated_at = now()
WHERE  source_type = 'idp';

DROP INDEX IF EXISTS idx_workspace_access_policy_rules_group;
DROP INDEX IF EXISTS idx_workspace_access_policy_rules_workspace;
DROP INDEX IF EXISTS idx_workspace_access_policy_rules_all_company_members;
DROP TABLE IF EXISTS workspace_access_policy_rules;

DROP INDEX IF EXISTS idx_workspace_member_grants_user;
DROP INDEX IF EXISTS idx_workspace_member_grants_workspace_user;
DROP TABLE IF EXISTS workspace_member_grants;