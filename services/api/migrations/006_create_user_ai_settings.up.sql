-- Migration: 006_create_user_ai_settings.up.sql
-- Per-user AI provider/model settings for Phase 3 generation.

CREATE TYPE ai_provider AS ENUM ('openai', 'github_copilot');

CREATE TABLE user_ai_settings (
    user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    provider               ai_provider NOT NULL,
    model                  TEXT NOT NULL,
    provider_config        JSONB NOT NULL DEFAULT '{}'::jsonb,
    encrypted_credentials  BYTEA,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON user_ai_settings (provider);