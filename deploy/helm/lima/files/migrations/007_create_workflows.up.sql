-- Migration: 007_create_workflows.up.sql
-- Phase 6: workflow model, triggers, step orchestration, and AI-generated
-- business-logic review. Mutating steps continue to flow through the existing
-- approval queue (FR-15) via the approval_id FK on workflow_runs.

CREATE TYPE workflow_trigger AS ENUM (
    'manual',
    'form_submit',
    'button_click',
    'schedule',
    'webhook'
);

CREATE TYPE workflow_status AS ENUM ('draft', 'active', 'archived');

CREATE TYPE workflow_step_type AS ENUM (
    'query',
    'mutation',
    'condition',
    'approval_gate',
    'notification'
);

CREATE TYPE workflow_run_status AS ENUM (
    'pending',
    'running',
    'awaiting_approval',
    'completed',
    'failed',
    'cancelled'
);

-- ---- Workflows -------------------------------------------------------------
-- status='draft' means AI-generated and not yet reviewed / activated by a
-- builder. Only workspace_admins may set status='active' (FR-15 / FR-19).

CREATE TABLE workflows (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    app_id            UUID    NOT NULL REFERENCES apps(id)        ON DELETE CASCADE,
    name              TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    description       TEXT,
    trigger_type      workflow_trigger NOT NULL DEFAULT 'manual',
    -- trigger_config holds trigger-specific JSON:
    --   manual:        {}
    --   form_submit:   { "widget_id": "<widgetId>" }
    --   button_click:  { "widget_id": "<widgetId>" }
    --   schedule:      { "cron": "<cron expression>" }
    --   webhook:       { "secret_token_hash": "<bcrypt hash>" }
    trigger_config    JSONB   NOT NULL DEFAULT '{}',
    status            workflow_status NOT NULL DEFAULT 'draft',
    -- When true, any mutation step will insert an approval record before
    -- executing the external write. Default to true for safety (FR-15).
    requires_approval BOOLEAN NOT NULL DEFAULT true,
    created_by        UUID    NOT NULL REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON workflows (workspace_id, app_id);
CREATE INDEX ON workflows (workspace_id, status);

-- ---- Workflow steps --------------------------------------------------------
-- Ordered steps within a workflow. ai_generated=true flags steps whose config
-- was written by the AI agent; a builder must review them (set reviewed_by /
-- reviewed_at) before the parent workflow can be activated.

CREATE TABLE workflow_steps (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id  UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    step_order   INT  NOT NULL,
    name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
    -- step_type drives execution semantics:
    --   query:         read-only connector fetch
    --   mutation:      write to a connector (requires approval if workflow.requires_approval)
    --   condition:     evaluates an expression; either continues or short-circuits
    --   approval_gate: pauses the run and creates an approval record
    --   notification:  emits an internal notification (no connector write)
    step_type    workflow_step_type NOT NULL,
    -- config schema per step_type:
    --   query/mutation:  { "connector_id": "..", "query": "..", "params": {} }
    --   condition:       { "expression": "<JS expression>" }
    --   approval_gate:   { "description": ".." }
    --   notification:    { "message": ".." }
    config       JSONB NOT NULL DEFAULT '{}',
    ai_generated BOOLEAN NOT NULL DEFAULT false,
    reviewed_by  UUID REFERENCES users(id),
    reviewed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workflow_id, step_order)
);

CREATE INDEX ON workflow_steps (workflow_id);

-- ---- Workflow runs ---------------------------------------------------------
-- One row per execution. Runs that hit an approval_gate or mutation step
-- that needs gating will link to the existing approvals table.

CREATE TABLE workflow_runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id   UUID NOT NULL REFERENCES workflows(id)   ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id)  ON DELETE CASCADE,
    status        workflow_run_status NOT NULL DEFAULT 'pending',
    triggered_by  UUID REFERENCES users(id),
    input_data    JSONB NOT NULL DEFAULT '{}',
    output_data   JSONB,
    error_message TEXT,
    -- Points to the approval record when the run is awaiting_approval.
    approval_id   UUID REFERENCES approvals(id) ON DELETE SET NULL,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ
);

CREATE INDEX ON workflow_runs (workflow_id, started_at DESC);
CREATE INDEX ON workflow_runs (workspace_id, status);
