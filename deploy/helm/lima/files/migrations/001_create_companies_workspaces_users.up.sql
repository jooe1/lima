-- Migration: 001_create_companies_workspaces_users.up.sql
-- Phase 1 foundations: identity, tenancy, and RBAC schema.

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- Companies --------------------------------------------------------------
CREATE TABLE companies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Workspaces -------------------------------------------------------------
CREATE TABLE workspaces (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, slug)
);

CREATE INDEX ON workspaces (company_id);

-- ---- Users ------------------------------------------------------------------
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    name        TEXT NOT NULL,
    -- SSO subject — the unique identifier from the IdP
    sso_subject TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, email)
);

CREATE INDEX ON users (company_id);
CREATE INDEX ON users (sso_subject) WHERE sso_subject IS NOT NULL;

-- ---- Workspace memberships (user ↔ workspace with role) --------------------
-- role: workspace_admin | app_builder | end_user
CREATE TYPE workspace_role AS ENUM ('workspace_admin', 'app_builder', 'end_user');

CREATE TABLE workspace_members (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         workspace_role NOT NULL DEFAULT 'end_user',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, user_id)
);

CREATE INDEX ON workspace_members (workspace_id);
CREATE INDEX ON workspace_members (user_id);
