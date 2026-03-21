-- Migration: 011_company_resources.down.sql
-- Reverses 011_company_resources.up.sql.

DROP TABLE IF EXISTS resource_grants;

ALTER TABLE connectors
    DROP COLUMN IF EXISTS policy_profile_id,
    DROP COLUMN IF EXISTS owner_scope,
    DROP COLUMN IF EXISTS company_id;
