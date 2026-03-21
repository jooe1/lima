-- Migration: 010_auth_scaffolding.down.sql
-- Reverses 010_auth_scaffolding.up.sql.

DROP TABLE IF EXISTS group_memberships;
DROP TABLE IF EXISTS company_groups;
DROP TABLE IF EXISTS company_role_bindings;
