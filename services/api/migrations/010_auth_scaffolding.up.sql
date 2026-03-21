-- Migration: 010_auth_scaffolding.up.sql
-- Phase 0 authorization scaffolding: company-level role bindings, groups,
-- and group memberships.  No application-level enforcement yet — tables are
-- populated by the backfill in 012 and consumed by the authz layer added in
-- a later phase.

-- ---- Company-level role bindings -------------------------------------------
-- Maps a subject (user or service_principal) to a company-scoped role.
-- role examples: 'company_admin', 'resource_admin', 'policy_admin', 'company_member'
CREATE TABLE company_role_bindings (
    company_id   UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    subject_type TEXT        NOT NULL,   -- 'user' | 'service_principal'
    subject_id   UUID        NOT NULL,
    role         TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, subject_type, subject_id, role)
);

CREATE INDEX ON company_role_bindings (subject_id, subject_type);

-- ---- Company groups ---------------------------------------------------------
-- Named sets of subjects scoped to a company.
-- source_type: 'manual' | 'workspace_synthetic' | 'idp'
-- workspace_synthetic groups are created automatically in migration 012.
CREATE TABLE company_groups (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    slug         TEXT        NOT NULL,
    source_type  TEXT        NOT NULL DEFAULT 'manual',
    -- For IdP-synced groups: opaque external identifier from the directory.
    -- For workspace_synthetic groups: the workspace id (uuid as text).
    external_ref TEXT,
    -- For IdP-managed groups: which IdP integration manages this group.
    managed_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, slug)
);

CREATE INDEX ON company_groups (company_id);
CREATE INDEX ON company_groups (company_id, source_type);

-- ---- Group memberships ------------------------------------------------------
-- Associates users with company_groups.
CREATE TABLE group_memberships (
    group_id  UUID        NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
    user_id   UUID        NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX ON group_memberships (user_id);
