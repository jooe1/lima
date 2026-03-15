-- Migration: 004_create_threads_messages.up.sql
-- Conversation threads and chat messages between builder and AI agent.

CREATE TABLE conversation_threads (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id       UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by   UUID NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON conversation_threads (app_id);

CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system');

CREATE TABLE thread_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id   UUID NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
    role        message_role NOT NULL,
    content     TEXT NOT NULL,
    -- Optional: DSL diff emitted by the assistant alongside this message
    dsl_patch   JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON thread_messages (thread_id, created_at);
